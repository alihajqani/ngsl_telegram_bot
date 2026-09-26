import { reportLog } from '@ngsl/monitor';
import { redisConnection } from '@ngsl/queue';
import { createLogger } from '@ngsl/shared';
import { Queue, Worker } from 'bullmq';
import { runContentFill } from '../jobs/content-fill.js';

const log = createLogger('worker.content-fill');

const QUEUE_NAME = 'content-fill';
const JOB_NAME = 'content.fill';

/**
 * A run starts every half hour and stops starting batches after 29 minutes, so
 * the next one follows almost at once while content is missing. At about two
 * minutes per eight-word batch, every word's collocations take roughly half a
 * day.
 */
const EVERY = '*/30 * * * *';
const BUDGET_MS = 29 * 60_000;

/**
 * Its own queue rather than the schedule queue: that one runs one job at a
 * time, and a half-hour content run would hold back the reminders and the
 * nightly boards.
 */
export async function startContentFillWorker(): Promise<Worker> {
  const connection = redisConnection();
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler(
    JOB_NAME,
    { pattern: EVERY },
    { name: JOB_NAME, opts: { removeOnComplete: 50, removeOnFail: 100 } },
  );

  const worker = new Worker(QUEUE_NAME, () => runContentFill(BUDGET_MS), {
    connection,
    concurrency: 1,
  });

  worker.on('failed', (job, error) => {
    log.error('Content fill failed', { error });
    reportLog('error', 'worker.content-fill', `Content fill failed: ${job?.id ?? 'unknown'}`, {
      error,
    });
  });

  log.info('Content fill scheduled', { every: EVERY, budgetMin: BUDGET_MS / 60_000 });
  return worker;
}
