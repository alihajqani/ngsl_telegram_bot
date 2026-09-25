import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
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
 *    If its schema is current, `--baseline` records every migration as
 *    applied without running any; from then on only newer ones run.
 */

const log = createLogger('db.migrate');

const migrationsFolder = resolve(workspaceRoot() ?? process.cwd(), 'packages/db/drizzle');

async function schemaState(): Promise<{ journal: boolean; tables: boolean }> {
  const [state] = await db().execute<{ journal: string | null; word: string | null }>(sql`
    select to_regclass('drizzle.__drizzle_migrations')::text as journal,
           to_regclass('public.word')::text as word
  `);
  return { journal: Boolean(state?.journal), tables: Boolean(state?.word) };
}

async function main(): Promise<'migrated' | 'pushed'> {
  const state = await schemaState();
  if (!state.journal && state.tables) {
    log.warn(
      'Schema was created with `drizzle-kit push` (no migration journal); leaving it as is. ' +
        'If the schema is current, run `migrate.js --baseline` once; otherwise apply the ' +
        'pending migrations by hand first.',
    );
    return 'pushed';
  }

  await migrate(db(), { migrationsFolder });
  log.info('Migrations applied', { migrationsFolder });
  return 'migrated';
}

/**
 * Record every migration in the folder as applied, running none, in the table
 * and with the hashes drizzle's migrator writes. Only for a pushed database
 * whose schema already matches the newest migration; refused otherwise.
 */
async function baseline(): Promise<void> {
  const state = await schemaState();
  if (state.journal) throw new Error('The database already has a migration journal; nothing to baseline.');
  if (!state.tables) throw new Error('The database is empty; run migrations instead of a baseline.');

  const migrations = readMigrationFiles({ migrationsFolder });
  await db().transaction(async (tx) => {
    await tx.execute(sql`create schema if not exists drizzle`);
    await tx.execute(sql`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )`);
    for (const migration of migrations) {
      await tx.execute(sql`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${migration.hash}, ${migration.folderMillis})`);
    }
  });
  log.info('Baseline recorded: every migration marked as applied', { migrations: migrations.length });
}

try {
  if (process.argv.includes('--baseline')) await baseline();
  else await main();
} catch (error) {
  log.error('Migration failed', { error });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
