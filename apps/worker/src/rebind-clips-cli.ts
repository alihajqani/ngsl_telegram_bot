import { allClipMedia, closeDatabase, replaceClipFileIds, type ClipMedia } from '@ngsl/db';
import { closeConnection, redisClient } from '@ngsl/queue';
import { config, createLogger } from '@ngsl/shared';
import { Bot, GrammyError, InputFile } from 'grammy';
import { planRebind, type RebindPlan, type StagedFileId } from './rebind.js';
import { vaultCaption, VaultNotConfiguredError } from './vault.js';

const log = createLogger('worker.rebind-clips');

const USAGE = `
Usage: node apps/worker/dist/rebind-clips-cli.js --to-token=<new token> [--status] [--apply] [--limit=N]

Moves every rendered clip from the bot in BOT_TOKEN to a new bot. A Telegram file_id belongs to
the bot that minted it, so the new bot cannot send the old ones: each clip is
downloaded with the old token and uploaded to the vault with the new one.

The new file_ids are staged in Redis; the database keeps the old ones, so the
running bot goes on serving clips until --apply. Resumable: a second run
stages only what is left, and a clip re-rendered meanwhile is staged again.

  (none)      Stage a new file_id for every clip that has none yet (hours:
              about 20 clips a minute, Telegram's limit for one group)
  --status    Report progress and exit
  --apply     Stage what is left, then write every staged file_id to the
              database in one transaction. Stop the bot and the worker first,
              and start them with the new BOT_TOKEN right after
  --limit=N   Stage at most N clips (a smoke test)

Run every step before BOT_TOKEN is changed: it names the bot moved from.
`;

/** Telegram lets one bot post about 20 messages a minute into one group. */
const UPLOAD_INTERVAL_MS = 3_100;
const MAX_ATTEMPTS = 4;
/** Staged ids outlive the switch, so a finished run can still be inspected. */
const STAGE_TTL_SECONDS = 30 * 86_400;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry a call Telegram rate-limited, after the wait it names. */
async function withFloodWait<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const isFlood = error instanceof GrammyError && error.error_code === 429;
      if (!isFlood || attempt >= MAX_ATTEMPTS) throw error;
      const seconds = error.parameters.retry_after ?? 30;
      log.warn('Rate limited; waiting', { seconds });
      await sleep((seconds + 1) * 1000);
    }
  }
}

async function loadStaged(key: string): Promise<Map<number, StagedFileId>> {
  const raw = await redisClient().hgetall(key);
  return new Map(
    Object.entries(raw).map(([segmentId, value]) => [Number(segmentId), JSON.parse(value) as StagedFileId]),
  );
}

async function currentPlan(key: string): Promise<{ plan: RebindPlan; clips: ClipMedia[] }> {
  const [clips, staged] = await Promise.all([allClipMedia(), loadStaged(key)]);
  const plan = planRebind(
    clips.map((c) => ({ segmentId: c.segmentId, fileId: c.telegramFileId })),
    staged,
  );
  return { plan, clips };
}

function report(plan: RebindPlan): void {
  console.log(`
  still to move          ${plan.toStage.length}
  moved, not applied     ${plan.ready.length}
  applied                ${plan.applied}
`);
}

async function download(bot: Bot, token: string, fileId: string): Promise<Buffer> {
  const file = await withFloodWait(() => bot.api.getFile(fileId));
  if (!file.file_path) throw new Error('Telegram returned no file_path');
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

let lastUploadAt = 0;

async function upload(bot: Bot, clip: ClipMedia, bytes: Buffer): Promise<string> {
  const vault = config().media.vault;
  if (!vault) throw new VaultNotConfiguredError();

  const wait = lastUploadAt + UPLOAD_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastUploadAt = Date.now();

  const message = await withFloodWait(() =>
    bot.api.sendVideo(vault.groupId, new InputFile(bytes, `${clip.segmentId}.mp4`), {
      message_thread_id: vault.threadId,
      caption: vaultCaption(clip),
      parse_mode: 'HTML',
      disable_notification: true,
      supports_streaming: true,
      ...(clip.width && clip.height ? { width: clip.width, height: clip.height } : {}),
      duration: Math.max(1, Math.round((clip.endMs - clip.startMs) / 1000)),
    }),
  );
  const fileId = message.video?.file_id;
  if (!fileId) throw new Error('The upload returned no video');
  return fileId;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const flag = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const limit = flag('limit') ? Number(flag('limit')) : undefined;
  const toToken = flag('to-token');
  if (!toToken) throw new Error('--to-token is required (see --help)');

  const vault = config().media.vault;
  if (!vault) throw new VaultNotConfiguredError();
  const fromToken = config().telegram.botToken;
  const from = new Bot(fromToken);
  const to = new Bot(toToken);

  const [fromBot, toBot] = await Promise.all([from.api.getMe(), to.api.getMe()]);
  if (fromBot.id === toBot.id) throw new Error('Both tokens belong to the same bot');
  const member = await to.api.getChatMember(vault.groupId, toBot.id);
  if (!['creator', 'administrator', 'member'].includes(member.status)) {
    throw new Error(`@${toBot.username} is not in the vault group (status: ${member.status})`);
  }
  console.log(`\n  moving clips from @${fromBot.username} to @${toBot.username}`);

  // Keyed by the new bot, so a later switch to yet another token starts clean.
  const key = `clip-rebind:${toBot.id}`;
  const { plan, clips } = await currentPlan(key);
  report(plan);
  if (argv.includes('--status')) return;

  const byId = new Map(clips.map((c) => [c.segmentId, c]));
  const targets = limit === undefined ? plan.toStage : plan.toStage.slice(0, limit);
  const redis = redisClient();
  let moved = 0;
  let failed = 0;

  for (const segmentId of targets) {
    const clip = byId.get(segmentId)!;
    try {
      const bytes = await download(from, fromToken, clip.telegramFileId);
      const fileId = await upload(to, clip, bytes);
      const staged: StagedFileId = { from: clip.telegramFileId, to: fileId };
      await redis.hset(key, String(segmentId), JSON.stringify(staged));
      await redis.expire(key, STAGE_TTL_SECONDS);
      moved += 1;
    } catch (error) {
      failed += 1;
      log.warn('Clip not moved', { segmentId, error });
    }
    if ((moved + failed) % 50 === 0) {
      log.info('Rebind progress', { moved, failed, of: targets.length });
    }
  }
  console.log(`\n  moved ${moved} clips, ${failed} failed`);

  if (!argv.includes('--apply')) return;

  const fresh = await currentPlan(key);
  const updated = await replaceClipFileIds(fresh.plan.ready);
  console.log(`\n  applied ${updated} new file_ids`);
  report((await currentPlan(key)).plan);
}

try {
  await main();
} catch (error) {
  log.error('Rebind failed', { error });
  process.exitCode = 1;
} finally {
  await closeConnection();
  await closeDatabase();
}
