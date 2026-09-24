import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  markUnalignable,
  markVideoDeadById,
  renderPlan,
  saveAlignments,
  saveSegmentMedia,
  setVideoMediaStatus,
  videoSegments,
  type VideoSegment,
} from '@ngsl/db';
import {
  alignSegments,
  analyzeAudio,
  cutClip,
  cutWindow,
  downloadSource,
  extractSpeechWav,
  isAlignerConfigured,
  probe,
  snapToSilence,
  YtdlpError,
  type AudioAnalysis,
  type Span,
} from '@ngsl/media';
import {
  botWallRemainingMs,
  QUEUE,
  redisConnection,
  tripBotWall,
  type VideoRenderJobData,
} from '@ngsl/queue';
import { config, createLogger } from '@ngsl/shared';
import { Worker, type Job } from 'bullmq';
import { uploadToVault } from '../vault.js';

const log = createLogger('worker.video-render');

/**
 * Render one source video:
 *
 *   plan sentences → download once → loudness + pauses → forced alignment
 *   → cut each sentence locally → upload to the vault → persist file_id
 *
 * Only the download touches YouTube. Each clip is saved as soon as it is
 * uploaded, so a job that dies halfway keeps its clips and a retry re-plans
 * around them.
 */
export async function processVideoRender(
  job: Job<VideoRenderJobData>,
  worker: Worker<VideoRenderJobData>,
): Promise<void> {
  // Honour a bot wall another job tripped: wait it out without spending an attempt.
  const paused = await botWallRemainingMs();
  if (paused > 0) {
    await worker.rateLimit(paused);
    throw Worker.RateLimitError();
  }

  const { videoId, ytVideoId, focusWordIds } = job.data;
  const { depthTarget, maxClipsPerVideo, botWallPauseMs } = config().jobs;
  const { alignMinScore, tmpDir } = config().media;

  let plan = await renderPlan(videoId, focusWordIds, depthTarget, maxClipsPerVideo, alignMinScore);
  if (plan.length === 0) {
    await setVideoMediaStatus(videoId, 'rendered');
    log.info('Nothing left to cut', { videoId: ytVideoId });
    return;
  }

  const dir = await mkdtemp(join(tmpDir, `video-${ytVideoId}-`));
  try {
    let source: string;
    try {
      source = await downloadSource(ytVideoId, dir);
    } catch (error) {
      if (error instanceof YtdlpError && error.kind === 'bot-wall') {
        const until = await tripBotWall(botWallPauseMs);
        log.error('YouTube bot wall — pausing every render', {
          videoId: ytVideoId,
          until: until.toISOString(),
        });
        await worker.rateLimit(botWallPauseMs);
        throw Worker.RateLimitError();
      }
      if (error instanceof YtdlpError && (error.kind === 'dead' || error.kind === 'drm')) {
        // Permanently unusable: stop planning it. Clips already minted from it
        // keep playing; they are files in Telegram's CDN.
        await markVideoDeadById(videoId);
        await setVideoMediaStatus(videoId, 'failed');
        log.warn('Source video is unusable; retired', { videoId: ytVideoId, kind: error.kind });
        return;
      }
      throw error;
    }

    const info = await probe(source);
    const audio = await analyzeAudio(source, info.durationMs);

    let segments = await videoSegments(videoId);
    if (isAlignerConfigured() && segments.some((s) => s.alignScore === null)) {
      const changed = await alignVideo(source, dir, segments);
      if (changed > 0) {
        segments = await videoSegments(videoId);
        // Alignment may have shown some planned sentences do not match the audio.
        plan = await renderPlan(videoId, focusWordIds, depthTarget, maxClipsPerVideo, alignMinScore);
      }
    }

    const position = new Map(segments.map((s, i) => [s.id, i]));
    let cut = 0;
    let skipped = 0;
    let alignedCuts = 0;

    for (const segmentId of plan) {
      const index = position.get(segmentId);
      if (index === undefined) continue;
      const current = segments[index]!;

      const choice = chooseWindow(current, segments[index - 1], segments[index + 1], audio, info.durationMs);
      if (!choice) {
        skipped += 1;
        continue;
      }

      const clip = await cutClip(source, choice.window, {
        gainDb: audio.gainDb,
        out: join(dir, `clip-${segmentId}.mp4`),
      });
      const fileId = await uploadToVault(clip, {
        ytVideoId,
        startMs: choice.window.startMs,
        endMs: choice.window.endMs,
        sentence: current.text,
      });
      await saveSegmentMedia({
        segmentId,
        telegramFileId: fileId,
        startMs: choice.window.startMs,
        endMs: choice.window.endMs,
        width: clip.width,
        height: clip.height,
        sizeBytes: clip.sizeBytes,
        aligned: choice.aligned,
      });
      await rm(clip.path, { force: true });
      await rm(clip.thumbnailPath, { force: true });

      cut += 1;
      if (choice.aligned) alignedCuts += 1;
      await job.updateProgress(Math.round((cut / plan.length) * 100));
    }

    await setVideoMediaStatus(videoId, 'rendered');
    log.info('Video rendered', {
      videoId: ytVideoId,
      planned: plan.length,
      cut,
      aligned: alignedCuts,
      skipped,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Align every not-yet-aligned sentence of the video. Returns how many segments
 * changed: aligned ones get word times, the ones the aligner could not place
 * are marked so they are never re-sent. An unreachable aligner changes nothing.
 */
async function alignVideo(source: string, dir: string, segments: readonly VideoSegment[]): Promise<number> {
  const wav = await extractSpeechWav(source, join(dir, 'speech.wav'));
  const pending = segments.filter((s) => s.alignScore === null);
  const aligned = await alignSegments(
    wav,
    pending.map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs, text: s.text })),
  );
  await rm(wav, { force: true });
  if (!aligned) return 0;

  const unalignable = pending.filter((s) => !aligned.has(s.id)).map((s) => s.id);
  await markUnalignable(unalignable);
  await saveAlignments(
    [...aligned.values()].map((a) => ({
      segmentId: a.id,
      alignedStartMs: a.startMs,
      alignedEndMs: a.endMs,
      alignScore: a.score,
      wordTimings: a.words,
    })),
  );
  log.info('Aligned sentences', {
    requested: pending.length,
    aligned: aligned.size,
    unalignable: unalignable.length,
  });
  return pending.length;
}

/**
 * Where to cut one sentence. Aligned word times give the exact spoken span,
 * and the neighbours' aligned times keep the padding out of them. Without an
 * alignment, the subtitle timing is snapped into the nearest pauses.
 */
function chooseWindow(
  current: VideoSegment,
  prev: VideoSegment | undefined,
  next: VideoSegment | undefined,
  audio: AudioAnalysis,
  sourceMs: number,
): { window: Span; aligned: boolean } | undefined {
  const { padBeforeMs, padAfterMs, maxMs, alignMinScore } = config().media;
  const isAligned = (s: VideoSegment | undefined): s is VideoSegment & { alignedStartMs: number; alignedEndMs: number } =>
    s !== undefined &&
    s.alignedStartMs !== null &&
    s.alignedEndMs !== null &&
    (s.alignScore ?? 0) >= alignMinScore;

  if (isAligned(current)) {
    const window = cutWindow(
      { startMs: current.alignedStartMs, endMs: current.alignedEndMs },
      {
        padBeforeMs,
        padAfterMs,
        maxMs,
        sourceMs,
        prevEndMs: isAligned(prev) ? prev.alignedEndMs : undefined,
        nextStartMs: isAligned(next) ? next.alignedStartMs : undefined,
      },
    );
    return window ? { window, aligned: true } : undefined;
  }

  const snapped = snapToSilence({ startMs: current.startMs, endMs: current.endMs }, audio.silences, {
    padBeforeMs,
    padAfterMs,
  });
  // The snapped span already sits inside the pauses, padding included.
  const window = cutWindow(snapped.span, { padBeforeMs: 0, padAfterMs: 0, maxMs, sourceMs });
  return window ? { window, aligned: false } : undefined;
}

export function startVideoRenderWorker(): Worker<VideoRenderJobData> {
  const { renderConcurrency, videosPerHour } = config().jobs;

  const worker: Worker<VideoRenderJobData> = new Worker<VideoRenderJobData>(
    QUEUE.videoRender,
    (job) => processVideoRender(job, worker),
    {
      connection: redisConnection(),
      concurrency: renderConcurrency,
      // Downloads per hour — the whole exposure to YouTube's bot wall.
      limiter: { max: videosPerHour, duration: 3_600_000 },
      // A long talk takes minutes to cut and upload; renewals keep the lock.
      lockDuration: 300_000,
    },
  );

  worker.on('failed', (job, error) => {
    log.warn('Video render failed', {
      videoId: job?.data.ytVideoId,
      attempt: job?.attemptsMade,
      error,
    });
  });

  log.info('Video render worker started', { concurrency: renderConcurrency, videosPerHour });
  return worker;
}
