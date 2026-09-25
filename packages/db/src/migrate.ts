import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createLogger, workspaceRoot } from '@ngsl/shared';
import { closeDatabase, db } from './client.js';

/**
 * `node packages/db/dist/migrate.js` — apply pending migrations from
 * `packages/db/drizzle`.
 *
 * It runs inside the app images, where `drizzle-kit` is not available (it is a
 * dev dependency and is pruned), using drizzle-orm's own migrator. That lets
 * `scripts/local-up.sh` set up a database with nothing but Docker on the host.
 *
 * Three starting points:
 *  - empty database: every migration runs;
 *  - migrated database (has the drizzle journal): only new migrations run;
 *  - database built with `drizzle-kit push` (tables but no journal): left
 *    alone, because replaying migration 0000 over existing tables would fail.
 *    Keep using `pnpm db:push` for it, or start over with a fresh volume.
 */

const log = createLogger('db.migrate');

async function main(): Promise<'migrated' | 'pushed'> {
  const [state] = await db().execute<{ journal: string | null; word: string | null }>(sql`
    select to_regclass('drizzle.__drizzle_migrations')::text as journal,
           to_regclass('public.word')::text as word
  `);

  if (!state?.journal && state?.word) {
    log.warn(
      'Schema was created with `drizzle-kit push` (no migration journal); leaving it as is. ' +
        'Apply schema changes with `pnpm db:push`, or reset the volume to switch to migrations.',
    );
    return 'pushed';
  }

  const migrationsFolder = resolve(workspaceRoot() ?? process.cwd(), 'packages/db/drizzle');
  await migrate(db(), { migrationsFolder });
  log.info('Migrations applied', { migrationsFolder });
  return 'migrated';
}

try {
  await main();
} catch (error) {
  log.error('Migration failed', { error });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
