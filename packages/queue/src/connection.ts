import { config } from '@ngsl/shared';
import type { ConnectionOptions, JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';

/**
 * Shared queue infrastructure.
 *
 * This lives in its own package because BOTH apps produce jobs: the worker runs
 * scheduled sweeps, and the bot enqueues just-in-time renders the moment a
 * learner's session picks its words. Only the worker consumes them.
 */

export const QUEUE = {
  clipRender: 'clip.render',
  corpusIngest: 'corpus.ingest',
  notify: 'notify',
  llm: 'llm',
} as const;

/** Lower number = sooner. A live session must jump the pre-warm backlog. */
export const PRIORITY = {
  session: 1,
  breadth: 5,
  depth: 20,
} as const;

let connection: Redis | undefined;

/** BullMQ requires `maxRetriesPerRequest: null` on its blocking connections. */
export function redisConnection(): ConnectionOptions {
  connection ??= new Redis(config().redis.url, { maxRetriesPerRequest: null });
  return connection;
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  // yt-dlp failures are usually rate-related, so back off generously.
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 2_000 },
};

export async function closeConnection(): Promise<void> {
  await connection?.quit();
  connection = undefined;
}
