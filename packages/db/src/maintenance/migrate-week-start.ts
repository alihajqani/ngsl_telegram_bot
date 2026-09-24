import { dayKey } from '@ngsl/core';
import { config, createLogger } from '@ngsl/shared';
import { closeDatabase, db } from '../client.js';
import { migrateLeaguesToSaturday } from './week-start.js';

/**
 * `pnpm db:week-saturday` — move stored leagues from Monday to Saturday weeks.
 *
 * Run once when upgrading to 2.1.0, ideally with the bot and worker stopped.
 * Safe to run again: it only touches leagues still keyed by a Monday.
 */

const log = createLogger('db.week-start');

try {
  const today = dayKey(new Date(), config().app.timezone);
  const result = await migrateLeaguesToSaturday(db(), today);
  log.info('Leagues moved to Saturday weeks', { today, ...result });
} catch (error) {
  log.error('Week-start migration failed', { error });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
