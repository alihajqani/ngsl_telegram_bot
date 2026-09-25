import { readFile } from 'node:fs/promises';
import { broadcastAudience } from '@ngsl/db';
import { redisClient } from '@ngsl/queue';
import { createLogger } from '@ngsl/shared';
import { deliver } from './dispatch.js';

const log = createLogger('worker.release');

/**
 * The release announcement: after a deploy of a new version, every learner is
 * told once which version it is and to tap /start. Telegram keeps the menu a
 * chat last received, so /start is how a learner picks up a changed menu.
 *
 * Copy lives here for the same reason as in `reminders.ts`: the worker has no
 * request context for the bot's `t()`.
 */
const COPY = {
  fa: (version: string) =>
    `🆕 <b>ربات به‌روز شد: نسخهٔ ${version}</b>\n\n` +
    'برای گرفتن منوی تازه و امکانات جدید، روی /start بزنید.',
  en: (version: string) =>
    `🆕 <b>The bot has been updated to version ${version}</b>\n\n` +
    'Tap /start to get the new menu and features.',
} as const;

/**
 * Five messages a second, a sixth of Telegram's bulk limit. An announcement is
 * not urgent, and flood control would cost more than a slow send.
 */
export const ANNOUNCE_INTERVAL_MS = 200;

const KEY = {
  /** The last version every learner was told about. */
  announced: 'ngsl:release:announced',
  /** Telegram id of the last learner reached, while a version is being sent. */
  cursor: (version: string) => `ngsl:release:${version}:cursor`,
};

const pause = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ANNOUNCE_INTERVAL_MS));

/** The deployed version, from this app's package.json (every package is released together). */
export async function appVersion(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

/**
 * Announce `version` unless it already was. Learners are reached in Telegram id
 * order and the last one is recorded after each message, so a worker restarted
 * midway resumes instead of messaging anyone twice.
 */
export async function announceRelease(
  version: string,
  wait: () => Promise<void> = pause,
): Promise<{ sent: number; skipped: boolean }> {
  const redis = redisClient();
  if ((await redis.get(KEY.announced)) === version) return { sent: 0, skipped: true };

  const reached = Number((await redis.get(KEY.cursor(version))) ?? 0);
  const audience = (await broadcastAudience())
    .filter((user) => user.telegramId > reached)
    .sort((a, b) => a.telegramId - b.telegramId);
  log.info('Announcing release', { version, audience: audience.length, resumed: reached > 0 });

  let sent = 0;
  for (const user of audience) {
    if (await deliver(user, COPY[user.locale](version))) sent += 1;
    await redis.set(KEY.cursor(version), String(user.telegramId));
    await wait();
  }

  await redis.set(KEY.announced, version);
  await redis.del(KEY.cursor(version));
  log.info('Release announced', { version, sent });
  return { sent, skipped: false };
}
