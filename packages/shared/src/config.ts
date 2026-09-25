import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { loadEnvFile } from './env.js';

/**
 * Zod-validated environment configuration.
 *
 * v1 read `process.env.X` ad hoc across ~20 files with `??` fallbacks at each
 * call site, so a typo'd or missing variable surfaced as a runtime failure deep
 * inside a handler — often hours after boot. Everything is parsed exactly once,
 * here, and the process refuses to start if anything is wrong.
 *
 * Consume via `config()`, never `process.env`.
 */

// ── Reusable primitives ─────────────────────────────────────────────────────

/** Comma-separated list → trimmed, non-empty string[]. */
const csv = z
  .string()
  .transform((raw) => raw.split(',').map((s) => s.trim()).filter(Boolean));

/** Comma-separated list of Telegram numeric IDs. */
const csvIds = csv.pipe(z.array(z.coerce.number().int()).min(1));

/** `true`/`1`/`yes` → true (case-insensitive). */
const bool = z
  .string()
  .transform((raw) => ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase()));

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/**
 * Telegram group/supergroup IDs are large negative numbers (-100…). They exceed
 * nothing dangerous at Number precision, but must not be silently truncated.
 */
const telegramChatId = z.coerce
  .number()
  .int()
  .refine((n) => Number.isSafeInteger(n), 'Telegram chat ID is not a safe integer');

/** v1 lesson: yt-dlp runs with an unpredictable CWD, so relative paths fail intermittently. */
const absolutePath = z
  .string()
  .min(1)
  .refine((p) => isAbsolute(p), 'must be an absolute path (yt-dlp runs with an unpredictable CWD)');

// ── Schema ──────────────────────────────────────────────────────────────────

const envSchema = z
  .object({
    // App
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    APP_TIMEZONE: z.string().min(1).default('Asia/Tehran'),

    // Telegram
    BOT_TOKEN: z
      .string()
      .regex(/^\d+:[A-Za-z0-9_-]{30,}$/, 'must look like 123456:ABC-DEF… (from @BotFather)'),
    REQUIRED_CHANNEL: z.string().min(2).optional(),
    ADMIN_TELEGRAM_IDS: csvIds,

    // Postgres
    DATABASE_URL: z
      .string()
      .refine((u) => /^postgres(ql)?:\/\//.test(u), 'must be a postgres:// connection string'),
    DATABASE_POOL_MAX: int(1, 100).default(10),

    // Redis (sessions + BullMQ)
    REDIS_URL: z.string().refine((u) => /^rediss?:\/\//.test(u), 'must be a redis:// URL'),

    // LLM
    LLM_PROVIDER: z.enum(['gemini', 'vllm']).default('gemini'),
    GEMINI_API_KEYS: csv.optional(),
    GEMINI_MODEL: z.string().min(1).default('gemini-2.0-flash'),
    VLLM_BASE_URL: z.string().min(1).optional(),
    VLLM_MODEL: z.string().min(1).optional(),
    VLLM_API_KEY: z.string().min(1).optional(),
    LLM_TIMEOUT_MS: int(1_000, 600_000).default(60_000),
    HTTPS_PROXY: z.string().min(1).optional(),

    // Media tooling
    YTDLP_BIN: z.string().min(1).default('yt-dlp'),
    FFMPEG_BIN: z.string().min(1).default('ffmpeg'),
    FFPROBE_BIN: z.string().min(1).default('ffprobe'),
    YOUTUBE_COOKIES_FILE: absolutePath.optional(),
    YTDLP_EXTRACTOR_ARGS: z.string().min(1).optional(),
    YTDLP_PROXY: z.string().min(1).optional(),
    /**
     * JavaScript runtime yt-dlp uses to solve YouTube's player challenges. Only
     * Deno is enabled by default and the images ship Node, so without this the
     * challenges go unsolved and formats go missing.
     */
    YTDLP_JS_RUNTIME: z.string().min(1).default('node'),
    CLIP_TMP_DIR: absolutePath.default('/tmp/ngsl-clips'),
    /** Silence kept before the first word and after the last one. */
    CLIP_PAD_BEFORE_MS: int(0, 2_000).default(250),
    CLIP_PAD_AFTER_MS: int(0, 2_000).default(400),
    /** A sentence longer than this is skipped rather than cut short. */
    CLIP_MAX_SEC: int(4, 60).default(20),
    CLIP_MAX_HEIGHT: int(144, 1080).default(480),
    /** Forced-alignment sidecar. Unset → cuts fall back to subtitle timing snapped to silence. */
    ALIGNER_URL: z.string().url().optional(),
    /** Alignments scoring below this are treated as a transcript that does not match the audio. */
    ALIGN_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.35),

    // Clip vault — a private forum topic used purely to mint reusable file_ids.
    CLIP_VAULT_GROUP_ID: telegramChatId.optional(),
    CLIP_VAULT_THREAD_ID: int(1, 2_147_483_647).optional(),

    // Observability — Telegram forum topics as an ops dashboard
    MONITOR_GROUP_ID: telegramChatId.optional(),
    MONITOR_THREAD_TECHNICAL: int(1, 2_147_483_647).optional(),
    MONITOR_THREAD_USERS: int(1, 2_147_483_647).optional(),
    MONITOR_THREAD_FEATURES: int(1, 2_147_483_647).optional(),
    MONITOR_THREAD_SUMMARY: int(1, 2_147_483_647).optional(),

    // Corpus ingest + clip render pacing (the bot-detection blast radius)
    INGEST_SUBTITLE_CONCURRENCY: int(1, 8).default(2),
    INGEST_REQUEST_DELAY_MS: int(0, 60_000).default(3_000),
    CLIP_RENDER_CONCURRENCY: int(1, 4).default(1),
    PREWARM_BREADTH_TARGET: int(1, 100).default(10),
    PREWARM_DEPTH_TARGET: int(1, 500).default(30),
    /** Source videos downloaded per hour — the whole exposure to YouTube's bot wall. */
    RENDER_VIDEOS_PER_HOUR: int(1, 120).default(12),
    /** Clips cut from one download. The download is the expensive part, so use it well. */
    RENDER_MAX_CLIPS_PER_VIDEO: int(1, 500).default(60),
    /** How long every YouTube-facing job stops after the bot wall appears. */
    BOT_WALL_PAUSE_MIN: int(5, 1_440).default(90),
    /** Re-read a channel's feed after this many days; until then ingest works from the cache. */
    ENUMERATE_TTL_DAYS: int(1, 365).default(30),

    // Feature flags
    ENABLE_PREWARM: bool.default('true'),
    ENABLE_REMINDERS: bool.default('true'),
    /** After a deploy of a new version, tell every learner once (worker startup). */
    ENABLE_RELEASE_ANNOUNCEMENT: bool.default('true'),
  })
  .superRefine((e, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if (e.LLM_PROVIDER === 'gemini' && (e.GEMINI_API_KEYS?.length ?? 0) === 0) {
      fail('GEMINI_API_KEYS', 'required when LLM_PROVIDER=gemini (comma-separated for rotation)');
    }
    if (e.LLM_PROVIDER === 'vllm' && !e.VLLM_BASE_URL) {
      fail('VLLM_BASE_URL', 'required when LLM_PROVIDER=vllm');
    }
    if (e.VLLM_BASE_URL && !e.VLLM_MODEL) {
      fail('VLLM_MODEL', 'required whenever VLLM_BASE_URL is set');
    }
    if (e.CLIP_VAULT_GROUP_ID && !e.CLIP_VAULT_THREAD_ID) {
      fail('CLIP_VAULT_THREAD_ID', 'required when CLIP_VAULT_GROUP_ID is set');
    }
    const threads = [
      e.MONITOR_THREAD_TECHNICAL,
      e.MONITOR_THREAD_USERS,
      e.MONITOR_THREAD_FEATURES,
      e.MONITOR_THREAD_SUMMARY,
    ];
    if (!e.MONITOR_GROUP_ID && threads.some(Boolean)) {
      fail('MONITOR_GROUP_ID', 'required when any MONITOR_THREAD_* is set');
    }
  });

type RawEnv = z.infer<typeof envSchema>;

// ── Shaped config ───────────────────────────────────────────────────────────

/** Force a leading `@` on channel usernames (ported from v1's normalizeChannelId). */
function normalizeChannel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('@') || trimmed.startsWith('-100')) return trimmed;
  return `@${trimmed}`;
}

function shape(e: RawEnv) {
  const vault =
    e.CLIP_VAULT_GROUP_ID && e.CLIP_VAULT_THREAD_ID
      ? { groupId: e.CLIP_VAULT_GROUP_ID, threadId: e.CLIP_VAULT_THREAD_ID }
      : undefined;

  return {
    app: {
      env: e.NODE_ENV,
      isProduction: e.NODE_ENV === 'production',
      logLevel: e.LOG_LEVEL,
      timezone: e.APP_TIMEZONE,
      // Not LLM-specific: Telegram is just as likely to need it.
      httpsProxy: e.HTTPS_PROXY,
    },
    telegram: {
      botToken: e.BOT_TOKEN,
      requiredChannel: normalizeChannel(e.REQUIRED_CHANNEL),
      adminIds: e.ADMIN_TELEGRAM_IDS,
    },
    db: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    redis: { url: e.REDIS_URL },
    llm: {
      provider: e.LLM_PROVIDER,
      timeoutMs: e.LLM_TIMEOUT_MS,
      gemini: { apiKeys: e.GEMINI_API_KEYS ?? [], model: e.GEMINI_MODEL },
      vllm: e.VLLM_BASE_URL
        ? { baseUrl: e.VLLM_BASE_URL, model: e.VLLM_MODEL!, apiKey: e.VLLM_API_KEY }
        : undefined,
    },
    media: {
      ytdlpBin: e.YTDLP_BIN,
      ffmpegBin: e.FFMPEG_BIN,
      ffprobeBin: e.FFPROBE_BIN,
      cookiesFile: e.YOUTUBE_COOKIES_FILE,
      extractorArgs: e.YTDLP_EXTRACTOR_ARGS,
      proxy: e.YTDLP_PROXY,
      jsRuntime: e.YTDLP_JS_RUNTIME,
      tmpDir: e.CLIP_TMP_DIR,
      padBeforeMs: e.CLIP_PAD_BEFORE_MS,
      padAfterMs: e.CLIP_PAD_AFTER_MS,
      maxMs: e.CLIP_MAX_SEC * 1000,
      maxHeight: e.CLIP_MAX_HEIGHT,
      alignerUrl: e.ALIGNER_URL,
      alignMinScore: e.ALIGN_MIN_SCORE,
      vault,
    },
    monitor: e.MONITOR_GROUP_ID
      ? {
          groupId: e.MONITOR_GROUP_ID,
          threads: {
            technical: e.MONITOR_THREAD_TECHNICAL,
            users: e.MONITOR_THREAD_USERS,
            features: e.MONITOR_THREAD_FEATURES,
            summary: e.MONITOR_THREAD_SUMMARY,
          },
        }
      : undefined,
    jobs: {
      subtitleConcurrency: e.INGEST_SUBTITLE_CONCURRENCY,
      requestDelayMs: e.INGEST_REQUEST_DELAY_MS,
      renderConcurrency: e.CLIP_RENDER_CONCURRENCY,
      breadthTarget: e.PREWARM_BREADTH_TARGET,
      depthTarget: e.PREWARM_DEPTH_TARGET,
      videosPerHour: e.RENDER_VIDEOS_PER_HOUR,
      maxClipsPerVideo: e.RENDER_MAX_CLIPS_PER_VIDEO,
      botWallPauseMs: e.BOT_WALL_PAUSE_MIN * 60_000,
      enumerateTtlDays: e.ENUMERATE_TTL_DAYS,
      prewarmEnabled: e.ENABLE_PREWARM,
      remindersEnabled: e.ENABLE_REMINDERS,
      releaseAnnouncementEnabled: e.ENABLE_RELEASE_ANNOUNCEMENT,
    },
  } as const;
}

export type Config = ReturnType<typeof shape>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  • ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parse an arbitrary env bag. Exported so tests can build configs without mutating process.env. */
export function parseConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Report every problem at once — chasing them one restart at a time is miserable.
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return shape(result.data);
}

let cached: Config | undefined;

/**
 * Memoized accessor. Call once at startup so failures surface before any I/O.
 *
 * Loading `.env` happens here rather than in an `import 'dotenv/config'` at the
 * top of each entrypoint: that idiom depends on the CWD, and on import order
 * holding across every future edit and auto-sort. `parseConfig` stays pure so
 * tests can pass their own bag without touching the filesystem.
 */
export function config(): Config {
  if (!cached) {
    loadEnvFile();
    cached = parseConfig();
  }
  return cached;
}

/** Test-only: drop the memoized instance. */
export function resetConfig(): void {
  cached = undefined;
}

/** Safe-to-log view — secrets replaced by their length. */
export function redactedConfig(c: Config = config()): Record<string, unknown> {
  const mask = (v: string | undefined) => (v ? `‹${v.length} chars›` : undefined);
  return {
    // A proxy URL can carry credentials — presence is all that is worth logging.
    app: { ...c.app, httpsProxy: c.app.httpsProxy ? '‹set›' : undefined },
    telegram: { ...c.telegram, botToken: mask(c.telegram.botToken) },
    db: { poolMax: c.db.poolMax, url: mask(c.db.url) },
    redis: { url: mask(c.redis.url) },
    llm: {
      provider: c.llm.provider,
      model: c.llm.provider === 'gemini' ? c.llm.gemini.model : c.llm.vllm?.model,
      geminiKeyCount: c.llm.gemini.apiKeys.length,
    },
    media: { ...c.media, cookiesFile: c.media.cookiesFile ? '‹set›' : undefined },
    monitor: c.monitor ? { groupId: c.monitor.groupId, threads: c.monitor.threads } : undefined,
    jobs: c.jobs,
  };
}
