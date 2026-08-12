import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { closeDatabase, db } from '@ngsl/db';
import { config, createLogger, workspaceRoot } from '@ngsl/shared';
import { enabledChannels, loadChannels, type ChannelConfig } from './channels.js';
import { ingestChannel, loadLexicon, type IngestStats } from './ingest.js';

const log = createLogger('media.cli');

const USAGE = `
Usage: pnpm ingest [options]

  --channels=<path>  Path to channels.yml       (default: data/channels.yml)
  --channel=<slug>   Ingest only this channel   (default: all enabled)
  --limit=<n>        Videos per channel         (default: 25)
  --delay=<ms>       Pause between videos       (default: INGEST_REQUEST_DELAY_MS)
  --list             Print the whitelist and exit
`;

function flag(argv: readonly string[], name: string): string | undefined {
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }

  // As in the seeder: a caller-supplied path is relative to their CWD, the
  // default is relative to the repo so the command works from any directory.
  const channelsFlag = flag(argv, 'channels');
  const channelsPath = channelsFlag
    ? resolve(process.cwd(), channelsFlag)
    : resolve(workspaceRoot() ?? process.cwd(), 'data/channels.yml');
  const all = await loadChannels(channelsPath);

  if (argv.includes('--list')) {
    for (const c of all) {
      console.log(
        `${c.enabled ? '✓' : '✗'} ${c.slug.padEnd(24)} tier ${c.tier}  ${c.order.padEnd(6)}  ${c.name}`,
      );
    }
    return;
  }

  const only = flag(argv, 'channel');
  const selected = only
    ? all.filter((c) => c.slug === only)
    : enabledChannels(all);

  if (selected.length === 0) {
    throw new Error(
      only ? `No channel with slug "${only}" in ${channelsPath}` : 'No enabled channels',
    );
  }

  const limit = Number(flag(argv, 'limit') ?? 25);
  const delayMs = Number(flag(argv, 'delay') ?? config().jobs.requestDelayMs);

  // yt-dlp writes subtitle files here before they are parsed.
  await mkdir(config().media.tmpDir, { recursive: true });

  const lexicon = await loadLexicon();
  log.info('Loaded NGSL lexicon', { lemmas: lexicon.size });

  const results: IngestStats[] = [];
  for (const channel of selected) {
    results.push(await ingestChannel(channel, lexicon, { limit, delayMs }, db()));
  }

  report(selected, results);
}

function report(channels: readonly ChannelConfig[], results: readonly IngestStats[]): void {
  const total = results.reduce(
    (acc, r) => ({
      manual: acc.manual + r.manual,
      none: acc.none + r.noManualSubs,
      segments: acc.segments + r.segments,
      occurrences: acc.occurrences + r.occurrences,
    }),
    { manual: 0, none: 0, segments: 0, occurrences: 0 },
  );

  console.log('\n  channel                  manual  no-subs  segments  occurrences');
  console.log('  ' + '─'.repeat(64));
  for (const r of results) {
    console.log(
      `  ${r.channel.padEnd(24)}${String(r.manual).padStart(6)}${String(r.noManualSubs).padStart(9)}` +
        `${String(r.segments).padStart(10)}${String(r.occurrences).padStart(13)}`,
    );
  }
  console.log('  ' + '─'.repeat(64));
  console.log(
    `  ${`${channels.length} channel(s)`.padEnd(24)}${String(total.manual).padStart(6)}` +
      `${String(total.none).padStart(9)}${String(total.segments).padStart(10)}` +
      `${String(total.occurrences).padStart(13)}\n`,
  );

  const probed = total.manual + total.none;
  if (probed > 0) {
    console.log(`  Manual-subtitle yield: ${Math.round((total.manual / probed) * 100)}%\n`);
  }
}

try {
  await main();
} catch (error) {
  log.error('Ingest failed', { error });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
