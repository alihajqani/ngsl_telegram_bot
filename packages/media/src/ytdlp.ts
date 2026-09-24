import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
  /session has been rate-limited/i,
];

export function classifyError(stderr: string): YtdlpErrorKind {
  if (DEAD_PATTERNS.some((p) => p.test(stderr))) return 'dead';
  if (DRM_PATTERNS.some((p) => p.test(stderr))) return 'drm';
  if (BOT_WALL_PATTERNS.some((p) => p.test(stderr))) return 'bot-wall';
  return 'transient';
}

export interface BaseArgsOptions {
  jsRuntime: string;
  cookiesPath?: string;
  extractorArgs?: string;
  proxy?: string;
}

/**
 * Flags shared by every invocation.
 *
 * `--js-runtimes` is not optional: current yt-dlp solves YouTube's player
 * challenges in JavaScript and enables only Deno by default. The images ship
 * Node, so without the flag formats silently go missing.
 */
export function buildBaseArgs(options: BaseArgsOptions): string[] {
  const args = [
    '--no-warnings',
    '--no-progress',
    '--ignore-config',
    '--js-runtimes', options.jsRuntime,
    '--socket-timeout', '30',
    '--retries', '3',
    '--retry-sleep', 'exp=2:60',
    // Pace requests; firing them back-to-back is what trips rate limiting.
    '--sleep-requests', '1',
  ];
  if (options.cookiesPath) args.push('--cookies', options.cookiesPath);
  if (options.extractorArgs) args.push('--extractor-args', options.extractorArgs);
  if (options.proxy) args.push('--proxy', options.proxy);
  return args;
}

let cookieCopy: Promise<string | undefined> | undefined;

/**
 * A private, writable copy of the cookie jar.
 *
 * yt-dlp writes the jar back when it exits, and the real file is mounted
 * read-only, so pointing yt-dlp at it crashes every call with EROFS. The copy
 * also keeps the rotated cookies YouTube hands out during this process's life.
 * The path must be absolute: yt-dlp runs with an unpredictable CWD. The copy is
 * a live session, so it is removed when the process exits.
 */
function writableCookies(): Promise<string | undefined> {
  cookieCopy ??= (async () => {
    const { cookiesFile, tmpDir } = config().media;
    if (!cookiesFile) return undefined;
    await mkdir(tmpDir, { recursive: true });
    const copy = join(tmpDir, `yt-cookies-${process.pid}.txt`);
    await copyFile(cookiesFile, copy);
    await chmod(copy, 0o600);
    process.once('exit', () => rmSync(copy, { force: true }));
    return copy;
  })();
  return cookieCopy;
}

export async function baseArgs(): Promise<string[]> {
  const { jsRuntime, extractorArgs, proxy } = config().media;
  return buildBaseArgs({ jsRuntime, extractorArgs, proxy, cookiesPath: await writableCookies() });
}

export interface RunOptions {
  timeoutMs?: number;
  /** stdout can be large (full JSON for a long playlist). */
  maxBufferBytes?: number;
}

export async function runYtdlp(args: string[], options: RunOptions = {}): Promise<string> {
  const { ytdlpBin } = config().media;
  const full = [...(await baseArgs()), ...args];

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
