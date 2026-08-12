import { mkdir } from 'node:fs/promises';
import { clipCoverage, closeDatabase } from '@ngsl/db';
import { config, createLogger } from '@ngsl/shared';
import { closeClipRenderQueue, closeConnection, runPrewarm } from '@ngsl/queue';
import { isVaultConfigured } from './vault.js';

const log = createLogger('worker.prewarm-cli');

const USAGE = `
Usage: pnpm prewarm [--depth] [--status]

  --status  Report clip coverage and exit (no jobs enqueued)
  --depth   Grow pools toward PREWARM_DEPTH_TARGET instead of the breadth floor

Enqueues render jobs only. Run \`pnpm worker\` to actually process them.
`;

async function status(): Promise<void> {
  const coverage = await clipCoverage();
  const { breadthTarget, depthTarget } = config().jobs;

  const rendered = coverage.reduce((sum, c) => sum + c.rendered, 0);
  const total = coverage.reduce((sum, c) => sum + c.total, 0);
  const atBreadth = coverage.filter((c) => c.rendered >= breadthTarget).length;
  const atDepth = coverage.filter((c) => c.rendered >= depthTarget).length;

  console.log(`
  words with clips     ${coverage.length}
  clips total          ${total}
  clips rendered       ${rendered}  (${total === 0 ? 0 : Math.round((rendered / total) * 100)}%)
  words at breadth ≥${String(breadthTarget).padEnd(3)} ${atBreadth}
  words at depth   ≥${String(depthTarget).padEnd(3)} ${atDepth}
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  if (argv.includes('--status')) {
    await status();
    return;
  }

  if (!isVaultConfigured()) {
    throw new Error('Clip vault is not configured — set CLIP_VAULT_GROUP_ID and CLIP_VAULT_THREAD_ID');
  }
  await mkdir(config().media.tmpDir, { recursive: true });

  const result = await runPrewarm(argv.includes('--depth') ? 'depth' : 'breadth');
  console.log(
    `\n  stage ${result.stage}: ${result.clipsCreated} clips created, ` +
      `${result.jobsEnqueued} render jobs enqueued across ${result.wordsConsidered} words\n`,
  );
}

try {
  await main();
} catch (error) {
  log.error('Pre-warm failed', { error });
  process.exitCode = 1;
} finally {
  await closeClipRenderQueue();
  await closeConnection();
  await closeDatabase();
}
