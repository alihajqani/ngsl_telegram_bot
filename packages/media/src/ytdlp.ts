import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, createLogger } from '@ngsl/shared';

const exec = promisify(execFile);
const log = createLogger('media.ytdlp');

/**
 * yt-dlp invocation, with v1's anti-bot-detection tuning ported verbatim.
 *
 * These flags are not decoration — they are the difference between a working
 * ingest and a server IP that gets "Sign in to confirm you're not a bot" on
 * every request. All three levers stay env-tunable so they can be retuned when
 * YouTube changes, without a redeploy.
 */

export class YtdlpError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly kind: YtdlpErrorKind,
  ) {
    super(message);
    this.name = 'YtdlpError';
  }
}

export type YtdlpErrorKind = 'dead' | 'drm' | 'bot-wall' | 'transient';

/** Permanently gone — never retry, and purge anything referencing it. */
const DEAD_PATTERNS = [
  /video unavailable/i,
  /has been removed/i,
  /private video/i,
  /account associated with this video has been terminated/i,
  /this video is no longer available/i,
  /video has been removed by the uploader/i,
  /members-only content/i,
];

const DRM_PATTERNS = [/drm/i, /protected by drm/i];

/** The wall. Back off hard — hammering makes it worse. */
const BOT_WALL_PATTERNS = [
  /sign in to confirm/i,
  /confirm you'?re not a bot/i,
  /http error 429/i,
  /too many requests/i,
];

export function classifyError(stderr: string): YtdlpErrorKind {
  if (DEAD_PATTERNS.some((p) => p.test(stderr))) return 'dead';
  if (DRM_PATTERNS.some((p) => p.test(stderr))) return 'drm';
  if (BOT_WALL_PATTERNS.some((p) => p.test(stderr))) return 'bot-wall';
  return 'transient';
}

/**
 * Flags shared by every invocation.
 *
 * `--cookies` must receive an ABSOLUTE path: yt-dlp runs with an unpredictable
 * CWD, and a relative path fails intermittently in a way that looks like a
 * network fault. The config schema enforces absoluteness.
 */
export function baseArgs(): string[] {
  const { cookiesFile, extractorArgs, proxy } = config().media;
  const args = [
    '--no-warnings',
    '--no-progress',
    '--ignore-config',
    '--socket-timeout', '30',
    '--retries', '3',
    '--retry-sleep', 'exp=2:60',
    // Pace requests; firing them back-to-back is what trips rate limiting.
    '--sleep-requests', '1',
  ];
  if (cookiesFile) args.push('--cookies', cookiesFile);
  if (extractorArgs) args.push('--extractor-args', extractorArgs);
  if (proxy) args.push('--proxy', proxy);
  return args;
}

export interface RunOptions {
  timeoutMs?: number;
  /** stdout can be large (full JSON for a long playlist). */
  maxBufferBytes?: number;
}

export async function runYtdlp(args: string[], options: RunOptions = {}): Promise<string> {
  const { ytdlpBin } = config().media;
  const full = [...baseArgs(), ...args];

  try {
    const { stdout } = await exec(ytdlpBin, full, {
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: options.maxBufferBytes ?? 256 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = extractStderr(error);
    const kind = classifyError(stderr);
    log.debug('yt-dlp failed', { kind, args: full.slice(-2).join(' ') });
    throw new YtdlpError(`yt-dlp failed (${kind})`, stderr, kind);
  }
}

/** execFile rejects with an Error carrying `stderr` as a string or Buffer. */
function extractStderr(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'stderr' in error) {
    const { stderr } = error;
    if (typeof stderr === 'string') return stderr;
    if (Buffer.isBuffer(stderr)) return stderr.toString('utf8');
  }
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/**
 * Bounded-concurrency async map that never rejects — mirrors v1's
 * `mapWithConcurrency`. One bad video must not abort a whole channel's ingest.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
    (async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          results[index] = { status: 'fulfilled', value: await fn(items[index]!, index) };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    })(),
  );

  await Promise.all(workers);
  return results;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
