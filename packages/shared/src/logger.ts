import { pino, type Logger as PinoLogger } from 'pino';
import { config } from './config.js';

/**
 * Structured logging.
 *
 * v1 hand-rolled a logger that fanned out to console + MongoDB + Telegram, with
 * a dynamic import to dodge a circular dependency. v2 uses pino and treats the
 * Telegram monitor as an ordinary transport registered by the app, so this
 * module has no dependency on Telegram at all.
 */

export interface LogContext {
  userId?: number;
  wordId?: number;
  lemma?: string;
  videoId?: string;
  clipId?: number;
  jobId?: string;
  queue?: string;
  action?: string;
  [key: string]: unknown;
}

let root: PinoLogger | undefined;

function rootLogger(): PinoLogger {
  if (root) return root;
  const { logLevel, isProduction } = config().app;

  root = pino({
    level: logLevel,
    // Pretty output in dev; newline-delimited JSON in production so the host
    // log shipper can parse it.
    ...(isProduction
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }),
    // Never let a token reach the log stream, even if someone logs a whole config.
    redact: {
      paths: ['botToken', '*.botToken', 'apiKey', '*.apiKey', 'url', '*.url', 'headers.authorization'],
      censor: '‹redacted›',
    },
    formatters: { level: (label) => ({ level: label }) },
  });
  return root;
}

/**
 * Extra destination for log lines, registered by the application.
 *
 * Inverted on purpose: the Telegram monitor depends on `@ngsl/shared`, so
 * having the logger import it would be a cycle. Apps register the sink at
 * startup instead, which also keeps the logger usable in tests and CLIs where
 * no monitor exists.
 */
export type LogSink = (
  level: 'error' | 'warn' | 'info',
  module: string,
  message: string,
  context: Record<string, unknown>,
) => void;

const sinks: LogSink[] = [];

export function addLogSink(sink: LogSink): void {
  sinks.push(sink);
}

export interface Logger {
  error(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
}

/** Normalize an unknown thrown value into something structured-loggable. */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function wrap(base: PinoLogger, module = ''): Logger {
  const emit =
    (level: 'error' | 'warn' | 'info' | 'debug') =>
    (msg: string, ctx?: LogContext): void => {
      const { error, ...rest } = ctx ?? {};
      base[level](error === undefined ? rest : { ...rest, error: serializeError(error) }, msg);

      // `debug` is intentionally excluded: mirroring verbose tracing into a
      // Telegram topic would drown the useful signal and trip rate limits.
      if (level !== 'debug' && sinks.length > 0) {
        for (const sink of sinks) {
          try {
            sink(level, module, msg, ctx ?? {});
          } catch {
            // A broken sink must never break the call site that logged.
          }
        }
      }
    };

  return {
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    child: (ctx) => wrap(base.child(ctx), module),
  };
}

/**
 * `const log = createLogger('media.ingest')` — module name shows on every line.
 *
 * Resolution is deferred to the first log call. Module-scope `createLogger(...)`
 * is the normal idiom, and eager resolution would parse config at *import* time
 * — meaning merely importing a module would throw without a complete
 * environment, which broke unit tests of otherwise pure functions.
 */
export function createLogger(module: string): Logger {
  let resolved: Logger | undefined;
  const target = (): Logger => (resolved ??= wrap(rootLogger().child({ module }), module));

  return {
    error: (msg, ctx) => target().error(msg, ctx),
    warn: (msg, ctx) => target().warn(msg, ctx),
    info: (msg, ctx) => target().info(msg, ctx),
    debug: (msg, ctx) => target().debug(msg, ctx),
    child: (ctx) => target().child(ctx),
  };
}
