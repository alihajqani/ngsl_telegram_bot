import { config, createLogger } from '@ngsl/shared';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const log = createLogger('db.client');

export type Database = PostgresJsDatabase<typeof schema>;

let pool: ReturnType<typeof postgres> | undefined;
let database: Database | undefined;

/**
 * Lazily-built singleton connection pool.
 *
 * The bot and the worker each own one. Ingest and clip rendering live in the
 * worker precisely so a long yt-dlp job can never starve the pool serving
 * interactive Telegram traffic.
 */
export function db(): Database {
  if (database) return database;

  const { url, poolMax } = config().db;
  pool = postgres(url, {
    max: poolMax,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: (notice) => log.debug('postgres notice', { notice: notice.message }),
  });

  database = drizzle(pool, { schema, casing: 'snake_case' });
  return database;
}

/** Verify connectivity at startup so a bad DATABASE_URL fails before serving traffic. */
export async function assertDatabaseReady(): Promise<void> {
  await db().execute(sql`select 1`);
  log.info('Database connection established');
}

export async function closeDatabase(): Promise<void> {
  if (!pool) return;
  await pool.end({ timeout: 5 });
  pool = undefined;
  database = undefined;
  log.info('Database connection closed');
}
