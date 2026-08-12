import {
  clipCoverage,
  db,
  ensureClipsForWord,
  findClipsToRender,
  findClipsToRenderForWord,
} from '@ngsl/db';
import { word } from '@ngsl/db/schema';
import { config, createLogger } from '@ngsl/shared';
import { Queue } from 'bullmq';
import { DEFAULT_JOB_OPTIONS, PRIORITY, QUEUE, redisConnection } from './connection.js';

const log = createLogger('queue.clip-render');

export interface ClipRenderJobData {
  clipId: number;
  ytVideoId: string;
  startMs: number;
  endMs: number;
}

let queue: Queue<ClipRenderJobData> | undefined;

export function clipRenderQueue(): Queue<ClipRenderJobData> {
  queue ??= new Queue<ClipRenderJobData>(QUEUE.clipRender, {
    connection: redisConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return queue;
}

/**
 * The job id is derived from the clip id, so BullMQ deduplicates: a clip already
 * queued or in flight is never rendered twice, however many times a sweep or a
 * live session asks for it.
 *
 * The separator is a hyphen, not a colon — BullMQ rejects custom job ids
 * containing `:` because it uses that character in its own Redis key scheme.
 */
export const clipJobId = (clipId: number): string => `clip-${clipId}`;

export async function enqueueClipRender(
  data: ClipRenderJobData,
  priority: number = PRIORITY.breadth,
): Promise<void> {
  const jobId = clipJobId(data.clipId);
  await clipRenderQueue().add('render', data, { jobId, priority });

  // De-duplication has a sharp edge: when the job id already exists, BullMQ
  // returns the existing job and silently discards the options — including the
  // priority. A learner asking for a word already sitting in the pre-warm
  // backlog would keep that job's low priority and wait behind the whole sweep,
  // which is the exact case this priority exists to fix. Promote explicitly.
  const existing = await clipRenderQueue().getJob(jobId);
  // Read `job.priority`, not `job.opts.priority`: changePriority rewrites the
  // former and the sorted-set score but leaves the stored opts untouched, so a
  // job promoted once still reports its original priority in opts and would be
  // "promoted" again on every subsequent request.
  //
  // Only ever raise priority (lower number), never lower it: a clip already
  // promoted by a live request must not be demoted by a later sweep. A job we
  // just created lands here with an equal priority and is left alone.
  if (existing && (existing.priority || PRIORITY.depth) > priority) {
    // An already-started job is past the point where priority means anything,
    // and changePriority throws on active jobs.
    const state = await existing.getState();
    if (state === 'prioritized' || state === 'waiting' || state === 'delayed') {
      await existing.changePriority({ priority });
      log.info('Promoted queued clip render', { clipId: data.clipId, priority });
    }
  }
}

export async function closeClipRenderQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}

function windowOptions(): { leadMs: number; maxMs: number } {
  const { leadSec, maxSec } = config().media;
  return { leadMs: leadSec * 1000, maxMs: maxSec * 1000 };
}

/**
 * Just-in-time pre-warm for the words a learner is about to study.
 *
 * Called the moment a session picks its words — which happens before any card is
 * rendered, so there is a real head start. Jobs go in at session priority so
 * they overtake the pre-warm backlog, and anything already rendered is skipped
 * by job-id deduplication rather than re-queued.
 */
export async function prewarmWords(wordIds: readonly number[]): Promise<number> {
  if (wordIds.length === 0) return 0;

  const target = config().jobs.breadthTarget;
  let enqueued = 0;

  for (const wordId of wordIds) {
    await ensureClipsForWord(wordId, target, windowOptions());

    // Scoped to this word. The unscoped backlog query answers a different
    // question — "what should the sweep do next" — and using it here queued a
    // handful of unrelated words at session priority while the word the learner
    // actually tapped stayed unrendered, so the reply never stopped saying
    // "being prepared".
    const pending = await findClipsToRenderForWord(wordId, target);
    for (const job of pending) {
      await enqueueClipRender(job, PRIORITY.session);
    }
    enqueued += pending.length;
  }

  if (enqueued > 0) {
    log.info('Session pre-warm enqueued', { words: wordIds.length, jobs: enqueued });
  }
  return enqueued;
}

export type PrewarmStage = 'breadth' | 'depth';

export interface PrewarmResult {
  stage: PrewarmStage;
  wordsConsidered: number;
  clipsCreated: number;
  jobsEnqueued: number;
}

/**
 * Scheduled sweep.
 *
 *   breadth — bring EVERY word up to a floor of rendered clips, so no learner
 *             ever meets a word with nothing to show.
 *   depth   — grow pools further, so "five different clips every review" keeps
 *             holding for the words people actually study.
 *
 * Breadth runs first: a word with zero clips is broken, a word with ten is
 * merely less varied.
 */
export async function runPrewarm(stage: PrewarmStage): Promise<PrewarmResult> {
  const { breadthTarget, depthTarget, renderBudget } = config().jobs;
  const target = stage === 'breadth' ? breadthTarget : depthTarget;

  const coverage = new Map((await clipCoverage()).map((c) => [c.wordId, c]));
  const words = await db().select({ id: word.id }).from(word);

  // Neediest first, so a truncated run still fixes the worst gaps.
  const candidates = words
    .map(({ id }) => ({
      id,
      rendered: coverage.get(id)?.rendered ?? 0,
      total: coverage.get(id)?.total ?? 0,
    }))
    .filter((w) => w.rendered < target)
    .sort((a, b) => a.rendered - b.rendered);

  let clipsCreated = 0;
  for (const candidate of candidates) {
    if (candidate.total >= target) continue;
    clipsCreated += await ensureClipsForWord(candidate.id, target, windowOptions());
  }

  const pending = await findClipsToRender(renderBudget);
  for (const job of pending) {
    await enqueueClipRender(job, stage === 'breadth' ? PRIORITY.breadth : PRIORITY.depth);
  }

  const result: PrewarmResult = {
    stage,
    wordsConsidered: candidates.length,
    clipsCreated,
    jobsEnqueued: pending.length,
  };
  log.info('Pre-warm sweep complete', { ...result });
  return result;
}
