import { mkdir } from 'node:fs/promises';
import { assertDatabaseReady, closeDatabase } from '@ngsl/db';
import { addLogSink, config, createLogger, redactedConfig } from '@ngsl/shared';
import type { Worker } from 'bullmq';
import { closeConnection, closeVideoRenderQueue, runPrewarm } from '@ngsl/queue';
import { isVaultConfigured } from './vault.js';
import { startVideoRenderWorker } from './workers/video-render.worker.js';
import { startScheduler } from './scheduler.js';
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

  if (cfg.jobs.prewarmEnabled && isVaultConfigured()) {
    // Breadth on boot so a fresh deploy starts closing gaps immediately.
    void runPrewarm('breadth').catch((error: unknown) =>
      log.error('Startup pre-warm failed', { error }),
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info('Draining workers', { signal });
    // close() waits for in-flight jobs; each clip is saved as soon as it is uploaded.
    await Promise.all(workers.map((w) => w.close()));
    await closeVideoRenderQueue();
    await closeConnection();
    await flushMonitor();
    await closeDatabase();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  log.info('Worker ready', { queues: workers.length });
}

main().catch((error: unknown) => {
  log.error('Fatal startup failure', { error });
  process.exit(1);
});
