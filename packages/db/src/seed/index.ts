import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLogger, workspaceRoot } from '@ngsl/shared';
import { closeDatabase, db } from '../client.js';
import { parseNgslCsv } from './ngsl-csv.js';
import { BUCKET_COUNT, seedWords } from './seed-words.js';

const log = createLogger('db.seed');

const DEFAULT_CSV = 'data/ngsl.csv';

interface Args {
  file: string;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flag = argv.find((a) => a.startsWith('--file='))?.slice('--file='.length);
  const supplied = flag ?? positional[0];

  return {
    // A path the caller typed is resolved against their CWD, which is what they
    // mean by a relative path. The default is a fixed file in the repo, so it is
    // anchored to the workspace root instead — otherwise `pnpm db:seed` only
    // works when launched from there.
    file: supplied
      ? resolve(process.cwd(), supplied)
      : resolve(workspaceRoot() ?? process.cwd(), DEFAULT_CSV),
    dryRun: argv.includes('--dry-run'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const contents = await readFile(args.file, 'utf8');
  const rows = parseNgslCsv(contents);
  log.info('Parsed NGSL list', { file: args.file, rows: rows.length });

  if (args.dryRun) {
    log.info('Dry run — CSV is valid, database untouched');
    return;
  }

  const result = await seedWords(db(), rows);

  const summary = result.buckets.map((b) => `${b.bucket}:${b.count}`).join('  ');
  log.info('Seeded word table', { rows: result.rows, buckets: result.buckets.length });
  log.info(`Bucket distribution (1 = most frequent)  ${summary}`);

  if (result.buckets.length !== BUCKET_COUNT) {
    // The word selector draws one candidate per bucket; a missing bucket would
    // silently narrow the difficulty spread of every batch.
    throw new Error(
      `Expected ${BUCKET_COUNT} populated buckets, found ${result.buckets.length}`,
    );
  }
}

try {
  await main();
} catch (error) {
  log.error('Seed failed', { error });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
