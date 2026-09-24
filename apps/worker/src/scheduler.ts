import { adminStats } from '@ngsl/db';
import { dayKey } from '@ngsl/core';
import { reconcileBuddyStreaks, runLeagueRollover } from '@ngsl/game';
import { reportDailyDigest, reportLog } from '@ngsl/monitor';
import { runPrewarm } from '@ngsl/queue';
import { config, createLogger } from '@ngsl/shared';
import { Queue, Worker, type Job } from 'bullmq';
import { redisConnection } from '@ngsl/queue';
import { runHealthSync } from './jobs/health-sync.js';
import { runNightlyBoards } from './jobs/nightly-boards.js';
import { runDailyMotivation, runPeakHourReminders } from './jobs/reminders.js';

const log = createLogger('worker.scheduler');

const QUEUE_NAME = 'schedule';

/**
 * Scheduled work, as BullMQ repeatable jobs rather than in-process `node-cron`.
 *
 * v1 ran eight cron jobs inside the bot: nothing survived a restart, two
 * instances would double-fire, and a long job blocked user traffic. Repeatable
 * jobs are durable, deduplicated by key, and executed here in the worker.
 */
const SCHEDULES: { name: string; cron: string }[] = [
  // Every hour, on the hour — peak-hour reminders select their own audience.
  { name: 'reminders.peak', cron: '0 * * * *' },
  { name: 'motivation.daily', cron: '0 6 * * *' },
  { name: 'buddy.reconcile', cron: '30 0 * * *' },
  // Saturday 00:00: Friday closes the league week.
  { name: 'league.rollover', cron: '0 0 * * 6' },
  { name: 'health.sync', cron: '0 3 * * 0' },
  { name: 'prewarm.breadth', cron: '*/30 * * * *' },
  { name: 'prewarm.depth', cron: '10 2 * * *' },
  { name: 'digest.daily', cron: '0 20 * * *' },
  { name: 'boards.nightly', cron: '0 22 * * *' },
];

async function run(name: string): Promise<void> {
  switch (name) {
    case 'reminders.peak':
      await runPeakHourReminders();
      return;
    case 'motivation.daily':
      await runDailyMotivation();
      return;
    case 'buddy.reconcile':
      await reconcileBuddyStreaks();
      return;
    case 'league.rollover':
      await runLeagueRollover();
      return;
    case 'health.sync':
      await runHealthSync();
      return;
    case 'prewarm.breadth':
      if (config().jobs.prewarmEnabled) await runPrewarm('breadth');
      return;
    case 'prewarm.depth':
      if (config().jobs.prewarmEnabled) await runPrewarm('depth');
      return;
    case 'boards.nightly':
      await runNightlyBoards();
      return;
    case 'digest.daily':
      reportDailyDigest(await adminStats(), dayKey(new Date(), config().app.timezone));
      return;
    default:
      log.warn('Unknown scheduled job', { name });
  }
}

export async function startScheduler(): Promise<Worker> {
  const connection = redisConnection();
  const queue = new Queue(QUEUE_NAME, { connection });

  // The cron timezone is the app timezone, so "06:00" means 06:00 for the
  // learners rather than 06:00 UTC.
  const tz = config().app.timezone;
  for (const schedule of SCHEDULES) {
    await queue.upsertJobScheduler(
      schedule.name,
      { pattern: schedule.cron, tz },
      { name: schedule.name, opts: { removeOnComplete: 50, removeOnFail: 100 } },
    );
  }

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      log.info('Scheduled job started', { job: job.name });
      await run(job.name);
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => {
    log.error('Scheduled job failed', { job: job?.name, error });
    reportLog('error', 'worker.scheduler', `Scheduled job failed: ${job?.name ?? 'unknown'}`, {
      error,
    });
  });

  log.info('Scheduler started', { jobs: SCHEDULES.length, timezone: tz });
  return worker;
}
