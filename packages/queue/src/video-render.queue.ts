import { clipCountsFor, videosForWord, videosToRender, wordCoverage } from '@ngsl/db';
import { config, createLogger } from '@ngsl/shared';
import { Queue } from 'bullmq';
import { DEFAULT_JOB_OPTIONS, PRIORITY, QUEUE, redisConnection } from './connection.js';

const log = createLogger('queue.video-render');

/**
 * One job per source video: download once, cut every clip the video is needed
 * for, upload each to the vault. The download is the only step that touches
 * YouTube, so batching per video is what keeps the bot wall away.
 */
export interface VideoRenderJobData {
  videoId: number;
  ytVideoId: string;
  /** Words a learner is waiting on; their sentences are cut and uploaded first. */
  focusWordIds: number[];
}

let queue: Queue<VideoRenderJobData> | undefined;

export function videoRenderQueue(): Queue<VideoRenderJobData> {
  queue ??= new Queue<VideoRenderJobData>(QUEUE.videoRender, {
    connection: redisConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return queue;
}

/**
 * The job id is derived from the video id, so BullMQ deduplicates: a video
 * already queued or in flight is never downloaded twice, however many sweeps
 * or learners ask for it.
 *
 * The separator is a hyphen, not a colon — BullMQ rejects custom job ids
 * containing `:` because it uses that character in its own Redis key scheme.
 */
export const videoJobId = (videoId: number): string => `video-${videoId}`;

/** Focus words to add to a queued job, or undefined when there is nothing new. */
export function mergeFocus(queued: readonly number[], requested: readonly number[]): number[] | undefined {
  const merged = [...new Set([...queued, ...requested])];
  return merged.length === queued.length ? undefined : merged;
}

export async function enqueueVideoRender(
  data: VideoRenderJobData,
  priority: number = PRIORITY.breadth,
): Promise<void> {
  const jobId = videoJobId(data.videoId);
  await videoRenderQueue().add('render', data, { jobId, priority });

  // De-duplication has a sharp edge: when the job id already exists, BullMQ
  // returns the existing job and silently discards the new options and data.
  // A learner asking for a word whose video already sits in the pre-warm
  // backlog would keep that job's low priority, and its sentence would not be
  // cut first. Promote and merge explicitly.
  const existing = await videoRenderQueue().getJob(jobId);
  if (!existing) return;

  const state = await existing.getState();
  // An active job is past the point where priority or data changes anything,
  // and changePriority throws on it.
  if (state !== 'prioritized' && state !== 'waiting' && state !== 'delayed') return;

  const focus = mergeFocus(existing.data.focusWordIds, data.focusWordIds);
  if (focus) await existing.updateData({ ...existing.data, focusWordIds: focus });

  // Read `job.priority`, not `job.opts.priority`: changePriority rewrites the
  // former but leaves the stored opts untouched. Only ever raise priority.
  if ((existing.priority || PRIORITY.depth) > priority) {
    await existing.changePriority({ priority });
    log.info('Promoted queued video render', { videoId: data.ytVideoId, priority });
  }
}

export async function closeVideoRenderQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}

/** Videos per word a learner is waiting on; two usually lift it past a few clips. */
const VIDEOS_PER_WAITING_WORD = 2;

/**
 * Just-in-time rendering for the words a learner is about to study.
 *
 * For every word still below the breadth floor, queue the best unrendered
 * videos that contain it, at session priority and with the word marked as
 * focus so its sentences are uploaded before anything else in those videos.
 */
export async function prewarmWords(wordIds: readonly number[]): Promise<number> {
  if (wordIds.length === 0) return 0;

  const { breadthTarget } = config().jobs;
  const { alignMinScore } = config().media;
  const covered = await clipCountsFor(wordIds);

  let enqueued = 0;
  for (const wordId of wordIds) {
    if ((covered.get(wordId) ?? 0) >= breadthTarget) continue;
    const videos = await videosForWord(wordId, VIDEOS_PER_WAITING_WORD, alignMinScore);
    for (const v of videos) {
      await enqueueVideoRender(
        { videoId: v.videoId, ytVideoId: v.ytVideoId, focusWordIds: [wordId] },
        PRIORITY.session,
      );
    }
    enqueued += videos.length;
  }

  if (enqueued > 0) log.info('Session pre-warm enqueued', { words: wordIds.length, videos: enqueued });
  return enqueued;
}

export type PrewarmStage = 'breadth' | 'depth';

export interface PrewarmResult {
  stage: PrewarmStage;
  wordsBelowTarget: number;
  videosEnqueued: number;
}

/**
 * Scheduled sweep.
 *
 *   breadth — bring EVERY word up to a floor of clips, so no learner ever
 *             meets a word with nothing to show.
 *   depth   — grow pools further, so a word keeps offering fresh clips on
 *             every review.
 *
 * Videos are chosen by how many under-covered words they help. The render
 * worker's hourly limiter paces the actual downloads; a sweep only decides the
 * order, so it enqueues about an hour's worth.
 */
export async function runPrewarm(stage: PrewarmStage): Promise<PrewarmResult> {
  const { breadthTarget, depthTarget, videosPerHour } = config().jobs;
  const { alignMinScore } = config().media;
  const target = stage === 'breadth' ? breadthTarget : depthTarget;

  const coverage = await wordCoverage();
  const wordsBelowTarget = coverage.filter((c) => c.rendered < target).length;

  const videos = wordsBelowTarget === 0 ? [] : await videosToRender(target, videosPerHour, alignMinScore);
  for (const v of videos) {
    await enqueueVideoRender(
      { videoId: v.videoId, ytVideoId: v.ytVideoId, focusWordIds: [] },
      stage === 'breadth' ? PRIORITY.breadth : PRIORITY.depth,
    );
  }

  const result: PrewarmResult = { stage, wordsBelowTarget, videosEnqueued: videos.length };
  log.info('Pre-warm sweep complete', { ...result });
  return result;
}
