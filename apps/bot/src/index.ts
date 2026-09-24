import { RedisAdapter } from '@grammyjs/storage-redis';
import { assertDatabaseReady, closeDatabase } from '@ngsl/db';
import { closeVideoRenderQueue, closeConnection } from '@ngsl/queue';
import { addLogSink, config, createLogger, redactedConfig } from '@ngsl/shared';
import { Bot, GrammyError, HttpError, session } from 'grammy';
import { run, sequentialize, type RunnerHandle } from '@grammyjs/runner';
import { Redis } from 'ioredis';
import {
  clipNavHandler,
  clipsHandler,
  clipVoteHandler,
  searchHandler,
  searchPromptHandler,
} from './handlers/clips.js';
import { collocationsHandler, examplesHandler } from './handlers/content.js';
import { newWordsHandler, reviewAnswerHandler, reviewHandler } from './handlers/sessions.js';
import {
  cancelWritingHandler,
  hasOpenWritingSession,
  writeHandler,
  writingSubmissionHandler,
} from './handlers/writing.js';
import { checkMembershipHandler, progressHandler, startHandler } from './handlers/start.js';
import {
  buddyHandler,
  globalBoardHandler,
  lazyBoardHandler,
  leagueHandler,
  streakHandler,
  wallOptInHandler,
} from './handlers/game.js';
import {
  adminBroadcastCancelHandler,
  adminBroadcastPromptHandler,
  adminHandler,
  broadcastHandler,
  isAwaitingBroadcast,
} from './handlers/admin.js';
import { digestOffHandler, settingsCallbackHandler, settingsHandler } from './handlers/settings.js';
import { flushMonitor, isMonitorEnabled, reportLog } from '@ngsl/monitor';
import { CB, CB_PATTERN, isEnglishQuery, menuKeyFor, type MenuKey } from './keyboards.js';
import { activityTracker, channelGuard, localeContext } from './middlewares.js';
import { initialSession, type BotContext, type SessionData } from './types.js';

const log = createLogger('bot.main');

const COMMANDS = [
  { command: 'start', description: 'Start / restart' },
  { command: 'newwords', description: 'Learn new words' },
  { command: 'review', description: 'Review due words' },
  { command: 'search', description: 'Search a word or phrase in clips' },
  { command: 'write', description: 'Writing practice' },
  { command: 'streak', description: 'Streak and points' },
  { command: 'league', description: "This week's league" },
  { command: 'lazy', description: 'Lazy Board' },
  { command: 'settings', description: 'Settings' },
  { command: 'progress', description: 'Your progress' },
];

/** Shown to Telegram clients set to Persian; everyone else gets `COMMANDS`. */
const COMMANDS_FA = [
  { command: 'start', description: 'شروع / شروع دوباره' },
  { command: 'newwords', description: 'واژه‌های جدید' },
  { command: 'review', description: 'مرور واژه‌ها' },
  { command: 'search', description: 'جست‌وجوی واژه یا عبارت در کلیپ‌ها' },
  { command: 'write', description: 'تمرین نوشتن' },
  { command: 'streak', description: 'امتیاز و رشته' },
  { command: 'league', description: 'لیگ هفته' },
  { command: 'lazy', description: 'تابلوی تنبل‌ها' },
  { command: 'settings', description: 'تنظیمات' },
  { command: 'progress', description: 'پیشرفت شما' },
];

/** Every main-menu button's handler. A `Record` so a new button without one fails the build. */
const MENU_ROUTES: Record<MenuKey, (ctx: BotContext) => Promise<void>> = {
  newWords: newWordsHandler,
  review: reviewHandler,
  writing: writeHandler,
  progress: progressHandler,
  streak: streakHandler,
  league: leagueHandler,
  lazy: lazyBoardHandler,
  search: searchPromptHandler,
  settings: settingsHandler,
  admin: adminHandler,
};

/** Best-effort: publishes the command menu, never throws. */
async function publishCommands(bot: Bot<BotContext>): Promise<void> {
  try {
    await bot.api.setMyCommands(COMMANDS);
    await bot.api.setMyCommands(COMMANDS_FA, { language_code: 'fa' });
    log.info('Command menu published');
  } catch (error) {
    log.warn('Could not publish the command menu — Telegram keeps the previous one', { error });
  }
}

async function main(): Promise<void> {
  const cfg = config();
  log.info('Configuration loaded', { config: redactedConfig(cfg) });

  // Mirror warnings and errors into the Telegram technical topic.
  if (isMonitorEnabled()) {
    addLogSink(reportLog);
    log.info('Telegram monitor enabled');
  }

  await assertDatabaseReady();

  const bot = new Bot<BotContext>(cfg.telegram.botToken);
  const redis = new Redis(cfg.redis.url);

  // ── Middleware chain ──────────────────────────────────────────────────────
  // sequentialize keeps one user's updates in order — without it, a fast
  // double-tap could process an answer before the card that produced it.
  bot.use(sequentialize((ctx) => ctx.from?.id.toString()));
  bot.use(
    session<SessionData, BotContext>({
      initial: initialSession,
      storage: new RedisAdapter({ instance: redis }),
      getSessionKey: (ctx) => ctx.from?.id.toString(),
    }),
  );
  bot.use(localeContext);
  bot.use(activityTracker);
  bot.use(channelGuard);

  // ── Commands ──────────────────────────────────────────────────────────────
  bot.command('start', startHandler);
  bot.command('newwords', newWordsHandler);
  bot.command('review', reviewHandler);
  bot.command('progress', progressHandler);
  bot.command('write', writeHandler);
  bot.command('streak', streakHandler);
  bot.command('league', leagueHandler);
  bot.command('lazy', lazyBoardHandler);
  bot.command('settings', settingsHandler);
  bot.command('search', (ctx) => (ctx.match ? searchHandler(ctx, ctx.match) : searchPromptHandler(ctx)));
  bot.command('admin', adminHandler);

  // ── Callback queries ──────────────────────────────────────────────────────
  bot.callbackQuery('chk', checkMembershipHandler);
  bot.callbackQuery('wcancel', cancelWritingHandler);
  bot.callbackQuery(CB.league, leagueHandler);
  bot.callbackQuery(CB.global, globalBoardHandler);
  bot.callbackQuery(CB.lazy, lazyBoardHandler);
  bot.callbackQuery(CB.buddy, buddyHandler);
  bot.callbackQuery(/^shame:(on|off)$/, wallOptInHandler);
  bot.callbackQuery(CB.broadcast, adminBroadcastPromptHandler);
  bot.callbackQuery(CB.broadcastCancel, adminBroadcastCancelHandler);
  bot.callbackQuery(CB.digestOff, digestOffHandler);
  bot.callbackQuery(/^st:/, settingsCallbackHandler);
  bot.callbackQuery(CB_PATTERN.examples, examplesHandler);
  bot.callbackQuery(CB_PATTERN.collocations, collocationsHandler);
  bot.callbackQuery(CB_PATTERN.clips, clipsHandler);
  bot.callbackQuery(CB_PATTERN.review, reviewAnswerHandler);
  bot.callbackQuery(CB_PATTERN.clipNav, clipNavHandler);
  bot.callbackQuery(CB_PATTERN.clipVote, clipVoteHandler);
  // Anything unmatched still needs acknowledging or the client spins forever.
  bot.on('callback_query:data', (ctx) => ctx.answerCallbackQuery());

  // ── Reply-keyboard buttons ────────────────────────────────────────────────
  // The labels are localized, so they are matched against the catalogue rather
  // than hardcoded strings.
  bot.on('message:text', async (ctx, next) => {
    // A free-text message during an open writing session is the submission, so
    // it must be checked before the menu labels — otherwise a paragraph that
    // happens to start with a button label would be routed as a command.
    // An admin composing a broadcast takes precedence over every other route.
    if (isAwaitingBroadcast(ctx)) {
      return broadcastHandler(ctx);
    }

    if (!ctx.message.text.startsWith('/') && (await hasOpenWritingSession(ctx))) {
      return writingSubmissionHandler(ctx);
    }

    const key = menuKeyFor(ctx.message.text);
    if (key) {
      ctx.session.awaitingSearch = false;
      return MENU_ROUTES[key](ctx);
    }

    // YouGlish-style: typing an English word or phrase searches the clips,
    // with or without pressing 🔎 first.
    if (ctx.session.awaitingSearch || isEnglishQuery(ctx.message.text)) {
      ctx.session.awaitingSearch = false;
      return searchHandler(ctx, ctx.message.text);
    }
    return next();
  });

  bot.catch((error) => {
    const { ctx } = error;
    if (error.error instanceof GrammyError) {
      log.error('Telegram API error', { userId: ctx.from?.id, error: error.error.description });
    } else if (error.error instanceof HttpError) {
      log.error('Network error reaching Telegram', { error: error.error });
    } else {
      log.error('Unhandled handler error', { userId: ctx.from?.id, error: error.error });
    }
  });

  // Long polling, concurrent via the runner. The server has no public ingress,
  // so a webhook is not an option — see the architecture notes.
  const runner: RunnerHandle = run(bot);
  log.info('Bot started', { mode: 'long-polling' });

  // Deliberately after the runner, and deliberately not awaited. Telegram
  // stores the command menu server-side and keeps the previous one when a
  // refresh fails, so publishing it is cosmetic upkeep — yet as the first
  // network call in startup it used to abort boot outright on any hiccup
  // (`HttpError: Network request for 'setMyCommands' failed!`). Off the
  // critical path it can neither delay polling nor prevent it.
  void publishCommands(bot);

  const shutdown = async (signal: string): Promise<void> => {
    log.info('Shutting down', { signal });
    if (runner.isRunning()) await runner.stop();
    await closeVideoRenderQueue();
    await closeConnection();
    await flushMonitor();
    await redis.quit();
    await closeDatabase();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  log.error('Fatal startup failure', { error });
  process.exit(1);
});
