import { mkdir } from 'node:fs/promises';
import { assertDatabaseReady, closeDatabase } from '@ngsl/db';
import { addLogSink, config, createLogger, redactedConfig } from '@ngsl/shared';
import type { Worker } from 'bullmq';
import { closeConnection, closeVideoRenderQueue, runPrewarm } from '@ngsl/queue';
import { isVaultConfigured } from './vault.js';
import { startVideoRenderWorker } from './workers/video-render.worker.js';
import { startScheduler } from './scheduler.js';
import { startContentFillWorker } from './workers/content-fill.worker.js';
import { announceRelease, appVersion } from './jobs/release-announcement.js';
import { flushMonitor, isMonitorEnabled, reportLog } from '@ngsl/monitor';

const log = createLogger('worker.main');

/**
 * The worker process owns every queue. Keeping it separate from the bot is the
 * point: a five-minute yt-dlp render must never sit on the event loop that is
 * answering Telegram updates.
 */
async function main(): Promise<void> {
  const cfg = config();
  log.info('Configuration loaded', { config: redactedConfig(cfg) });

  // Mirror warnings and errors into the Telegram technical topic.
  if (isMonitorEnabled()) {
    addLogSink(reportLog);
    log.info('Telegram monitor enabled');
  }

  await assertDatabaseReady();
  await mkdir(cfg.media.tmpDir, { recursive: true });

  if (!isVaultConfigured()) {
    // Without a vault there is nowhere to mint file_ids, so rendering is inert.
    log.warn('Clip vault is not configured — clip rendering is disabled');
  }

  const workers: Worker[] = [];
  if (isVaultConfigured()) {
    workers.push(startVideoRenderWorker());
  }
  workers.push(await startScheduler());
  const contentFill = cfg.jobs.contentFillEnabled ? await startContentFillWorker() : undefined;

  if (cfg.jobs.prewarmEnabled && isVaultConfigured()) {
    // Breadth on boot so a fresh deploy starts closing gaps immediately.
    void runPrewarm('breadth').catch((error: unknown) =>
      log.error('Startup pre-warm failed', { error }),
    );
  }

  if (cfg.jobs.releaseAnnouncementEnabled) {
    // Once per version, paced; a restart mid-send resumes where it stopped.
    void appVersion()
      .then((version) => announceRelease(version))
      .catch((error: unknown) => log.error('Release announcement failed', { error }));
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info('Draining workers', { signal });
    // close() waits for in-flight jobs; each clip is saved as soon as it is uploaded.
    // A content run can take half an hour, so it is not waited for: every word
    // is saved as its batch returns, and the stalled run is picked up again.
    await Promise.all([...workers.map((w) => w.close()), contentFill?.close(true)]);
    await closeVideoRenderQueue();
    await closeConnection();
    await flushMonitor();
    await closeDatabase();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  log.info('Worker ready', { queues: workers.length + (contentFill ? 1 : 0) });
}

main().catch((error: unknown) => {
  log.error('Fatal startup failure', { error });
  process.exit(1);
});
