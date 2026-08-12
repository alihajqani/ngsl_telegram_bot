import { config, createLogger, proxyFetch, serializeError } from '@ngsl/shared';

/**
 * Telegram forum topics as an observability dashboard.
 *
 * v1's best operational idea, rebuilt: errors, user events and daily digests go
 * into separate topics of one private supergroup, so the whole system is
 * legible from a phone without an ops stack.
 *
 * Deliberately built on plain `fetch` rather than grammY — this is imported by
 * the bot AND the worker, and a logging transport should not pull a bot
 * framework into a queue process.
 */

const log = createLogger('monitor');

export type Topic = 'technical' | 'users' | 'features' | 'summary';

/**
 * Telegram rate-limits a single chat to roughly 20 messages/minute, and a busy
 * error path can burst far past that. Messages are queued and drained on an
 * interval; when the backlog overflows, the OLDEST are dropped — during an
 * incident the newest events are the informative ones.
 */
const SEND_INTERVAL_MS = 1_500;
const MAX_QUEUE = 50;

/**
 * Telemetry must never be able to take the process down, so every failure mode
 * below ends in a console line rather than a rejection:
 *
 *  - unreachable API (the common case on a restricted network) — retry the
 *    message with an exponential backoff, capped, logging once per streak;
 *  - a misconfigured destination (wrong group id, bot not an admin) — no amount
 *    of retrying fixes it, so the monitor switches itself off with one message
 *    saying what to fix, instead of a 400 every 1.5 s forever;
 *  - a single malformed message — dropped on its own, monitor stays up.
 */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

interface Pending {
  topic: Topic;
  text: string;
}

const queue: Pending[] = [];
let timer: NodeJS.Timeout | undefined;
/** Guards against a send failure being logged, which would re-enter this queue. */
let draining = false;
/** Set once the destination is proven unusable; nothing is sent afterwards. */
let disabled = false;
let failureStreak = 0;
let retryAfter = 0;

type Outcome = 'ok' | 'retry' | 'drop';

function threadFor(topic: Topic): number | undefined {
  return config().monitor?.threads[topic];
}

export function isMonitorEnabled(): boolean {
  return !disabled && config().monitor !== undefined;
}

/** Never log through the normal logger from here — that path feeds this queue. */
function report(message: string): void {
  console.error(`[monitor] ${message}`);
}

function disable(reason: string): void {
  disabled = true;
  queue.length = 0;
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  report(`disabled — ${reason}`);
}

/**
 * Errors that will repeat on every future send: the chat does not exist, the
 * bot was never added, the token is wrong. Anything else (including a 400 about
 * the message itself) is treated as specific to one message.
 */
function isFatal(status: number, description: string): boolean {
  if (status === 401 || status === 403 || status === 404) return true;
  if (status !== 400) return false;
  return /chat not found|chat_id is empty|thread not found|not enough rights|CHAT_WRITE_FORBIDDEN|group chat was upgraded/i.test(
    description,
  );
}

function noteFailure(message: string): void {
  failureStreak += 1;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failureStreak - 1), BACKOFF_MAX_MS);
  retryAfter = Date.now() + delay;
  // One line per streak, not per attempt — an outage should not become the log.
  if (failureStreak === 1) report(`${message} — retrying, further failures silenced`);
}

/** Resolves to how the message should be treated. Never rejects. */
async function send(topic: Topic, text: string): Promise<Outcome> {
  const monitor = config().monitor;
  if (!monitor || disabled) return 'drop';

  const token = config().telegram.botToken;
  try {
    const response = await proxyFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: monitor.groupId,
        message_thread_id: threadFor(topic),
        text: text.slice(0, 4000),
        parse_mode: 'HTML',
        disable_notification: topic !== 'technical',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) {
      failureStreak = 0;
      retryAfter = 0;
      return 'ok';
    }

    const body = await response.text().catch(() => '');
    if (isFatal(response.status, body)) {
      disable(`Telegram rejected every message (${response.status}): ${body.slice(0, 200)}`);
      return 'drop';
    }
    // 429 and 5xx are worth retrying; a message-specific 400 is not.
    if (response.status === 429 || response.status >= 500) {
      noteFailure(`send failed: ${response.status}`);
      return 'retry';
    }
    report(`message dropped: ${response.status} ${body.slice(0, 200)}`);
    return 'drop';
  } catch (error) {
    noteFailure(`send failed: ${(error as Error)?.message ?? String(error)}`);
    return 'retry';
  }
}

function scheduleDrain(): void {
  if (timer || disabled) return;
  timer = setInterval(() => {
    if (draining || disabled) return;
    if (Date.now() < retryAfter) return;
    const next = queue.shift();
    if (!next) {
      clearInterval(timer);
      timer = undefined;
      return;
    }
    draining = true;
    void send(next.topic, next.text)
      .then((outcome) => {
        // Put it back at the front so ordering survives a transient outage.
        if (outcome === 'retry' && !disabled && queue.length < MAX_QUEUE) queue.unshift(next);
      })
      .catch(() => undefined)
      .finally(() => {
        draining = false;
      });
  }, SEND_INTERVAL_MS);
  // Do not hold the process open just to flush telemetry.
  timer.unref?.();
}

export function post(topic: Topic, text: string): void {
  if (!isMonitorEnabled()) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({ topic, text });
  scheduleDrain();
}

const LEVEL_ICON: Record<string, string> = {
  error: '🔴',
  warn: '⚠️',
  info: 'ℹ️',
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Mirror a structured log line into the technical topic. */
export function reportLog(
  level: 'error' | 'warn' | 'info',
  module: string,
  message: string,
  context: Record<string, unknown> = {},
): void {
  const lines = [`${LEVEL_ICON[level] ?? ''} <b>${escapeHtml(message)}</b>`, `<code>${module}</code>`];

  const { error, ...rest } = context;
  if (Object.keys(rest).length > 0) {
    lines.push(`<pre>${escapeHtml(JSON.stringify(rest, null, 2).slice(0, 800))}</pre>`);
  }
  if (error !== undefined) {
    const normalized = serializeError(error);
    // serializeError returns unknown-valued fields; narrow before stringifying
    // so a non-string stack cannot render as "[object Object]".
    const detail =
      typeof normalized.stack === 'string'
        ? normalized.stack
        : typeof normalized.message === 'string'
          ? normalized.message
          : '';
    const stack = detail.split('\n').slice(0, 5).join('\n');
    lines.push(`<pre>${escapeHtml(stack)}</pre>`);
  }

  post('technical', lines.join('\n'));
}

export function reportUserJoined(name: string, telegramId: number, total: number): void {
  post('users', `👤 <b>${escapeHtml(name)}</b> joined\n<code>${telegramId}</code> · ${total} users`);
}

export function reportFeature(feature: string, name: string, detail = ''): void {
  post('features', `✨ <b>${escapeHtml(name)}</b> used <code>${feature}</code> ${escapeHtml(detail)}`);
}

export interface DailyDigest {
  users: number;
  activeToday: number;
  activeWeek: number;
  blocked: number;
  wordsLearned: number;
  pointsAwarded: number;
  liveVideos: number;
  deadVideos: number;
  renderedClips: number;
}

export function reportDailyDigest(stats: DailyDigest, date: string): void {
  post(
    'summary',
    [
      `📊 <b>Daily digest — ${date}</b>`,
      '',
      `👥 users: <b>${stats.users}</b>  (today ${stats.activeToday}, week ${stats.activeWeek})`,
      `🚫 blocked: ${stats.blocked}`,
      `📚 words in decks: <b>${stats.wordsLearned}</b>`,
      `⭐ points awarded: <b>${stats.pointsAwarded}</b>`,
      `🎬 clips rendered: <b>${stats.renderedClips}</b>`,
      `📺 videos: ${stats.liveVideos} live / ${stats.deadVideos} dead`,
    ].join('\n'),
  );
  log.debug('Daily digest posted');
}

/**
 * Flush anything still queued — called during graceful shutdown.
 *
 * One attempt per message, and the first failure ends the flush: shutdown must
 * not stall for a queue's worth of 15 s timeouts when the API is unreachable.
 */
export async function flushMonitor(): Promise<void> {
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;
    const outcome = await send(next.topic, next.text).catch(() => 'drop');
    if (outcome !== 'ok') {
      queue.length = 0;
      return;
    }
  }
}
