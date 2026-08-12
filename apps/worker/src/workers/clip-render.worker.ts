import { db, markVideoDead, saveClipFileId } from '@ngsl/db';
import { clip as clipTable } from '@ngsl/db/schema';
import { renderClip, YtdlpError } from '@ngsl/media';
import { config, createLogger } from '@ngsl/shared';
import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { QUEUE, redisConnection, type ClipRenderJobData } from '@ngsl/queue';
import { uploadToVault } from '../vault.js';

const log = createLogger('worker.clip-render');

/**
 * Render one clip and mint its Telegram `file_id`.
 *
 *   yt-dlp --download-sections → upload to vault → persist file_id → unlink
 *
 * Every step after the download is cheap; the download is the one that can trip
 * YouTube's bot wall, which is why concurrency defaults to 1 and the queue is
 * rate-limited. Temp files are removed in a `finally`, so a failure mid-upload
 * cannot leak disk.
 */
export async function processClipRender(job: Job<ClipRenderJobData>): Promise<void> {
  const { clipId, ytVideoId, startMs, endMs } = job.data;

  // Idempotence: the pre-warm sweep and a live request can both ask for the same
  // clip, and a retried job may run after a successful upload.
  const existing = await db().query.clip.findFirst({
    where: eq(clipTable.id, clipId),
    columns: { telegramFileId: true },
  });
  if (existing?.telegramFileId) {
    log.debug('Clip already rendered', { clipId });
    return;
  }

  let cleanup: (() => Promise<void>) | undefined;
  try {
    const rendered = await renderClip(ytVideoId, { startMs, endMs });
    cleanup = rendered.cleanup;

    const fileId = await uploadToVault(rendered.path, { ytVideoId, startMs, endMs });
    await saveClipFileId(clipId, fileId);

    log.info('Clip rendered', { clipId, videoId: ytVideoId });
  } catch (error) {
    if (error instanceof YtdlpError && (error.kind === 'dead' || error.kind === 'drm')) {
      // Permanently unusable source. Disable it rather than retrying forever —
      // but leave every already-minted file_id intact: those clips still play.
      await markVideoDead(ytVideoId);
      log.warn('Source video is unusable; disabled', { clipId, videoId: ytVideoId });
      return;
    }
    throw error;
  } finally {
    await cleanup?.();
  }
}

export function startClipRenderWorker(): Worker<ClipRenderJobData> {
  const { renderConcurrency, renderBudget } = config().jobs;

  const worker = new Worker<ClipRenderJobData>(QUEUE.clipRender, processClipRender, {
    connection: redisConnection(),
    concurrency: renderConcurrency,
    // Pace the whole queue, not just each job: the budget is how many renders we
    // are willing to expose to YouTube per hour.
    limiter: { max: renderBudget, duration: 3_600_000 },
  });

  worker.on('failed', (job, error) => {
    log.warn('Clip render failed', { clipId: job?.data.clipId, attempt: job?.attemptsMade, error });
  });

  log.info('Clip render worker started', { concurrency: renderConcurrency, hourlyBudget: renderBudget });
  return worker;
}
