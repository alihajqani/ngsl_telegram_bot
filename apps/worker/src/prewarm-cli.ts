import { mkdir } from 'node:fs/promises';
import { closeDatabase, renderedClipCount, wordCoverage } from '@ngsl/db';
import { config, createLogger } from '@ngsl/shared';
import { closeConnection, closeVideoRenderQueue, runPrewarm } from '@ngsl/queue';
import { isVaultConfigured } from './vault.js';

const log = createLogger('worker.prewarm-cli');

const USAGE = `
Usage: pnpm prewarm [--depth] [--status]

  --status  Report clip coverage and exit (no jobs enqueued)
  --depth   Grow pools toward PREWARM_DEPTH_TARGET instead of the breadth floor

Enqueues video render jobs only. Run \`pnpm worker\` to actually process them.
`;

async function status(): Promise<void> {
  const [coverage, clips] = await Promise.all([wordCoverage(), renderedClipCount()]);
  const { breadthTarget, depthTarget } = config().jobs;

  const withClips = coverage.filter((c) => c.rendered > 0).length;
  const atBreadth = coverage.filter((c) => c.rendered >= breadthTarget).length;
  const atDepth = coverage.filter((c) => c.rendered >= depthTarget).length;

  console.log(`
  clips rendered       ${clips}
  words with a clip    ${withClips} / ${coverage.length}
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
    `\n  stage ${result.stage}: ${result.wordsBelowTarget} words below target, ` +
      `${result.videosEnqueued} videos enqueued\n`,
  );
}

try {
  await main();
} catch (error) {
  log.error('Pre-warm failed', { error });
  process.exitCode = 1;
} finally {
  await closeVideoRenderQueue();
  await closeConnection();
  await closeDatabase();
}
