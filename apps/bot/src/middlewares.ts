import { touchActivity, upsertUser } from '@ngsl/db';
import { config, createLogger } from '@ngsl/shared';
import type { NextFunction } from 'grammy';
import { detectLocale, runWithLocale, t } from './i18n/i18n.js';
import { channelPromptKeyboard } from './keyboards.js';
import type { BotContext } from './types.js';

const log = createLogger('bot.middleware');

/**
 * Resolve the user, then run the rest of the chain inside their locale.
 *
 * Everything downstream calls `t()` with no locale argument, so this must wrap
 * `next()` rather than merely setting a field — the AsyncLocalStorage scope has
 * to still be open when handlers run.
 */
export async function localeContext(ctx: BotContext, next: NextFunction): Promise<void> {
  const from = ctx.from;
  if (!from) return next();

  let locale = ctx.session.locale;

  if (ctx.session.userId === undefined || locale === undefined) {
    const user = await upsertUser(from.id, {
      firstName: from.first_name,
      username: from.username,
      languageCode: detectLocale(from.language_code),
    });
    ctx.session.userId = user.id;
    ctx.session.locale = user.locale;
    locale = user.locale;
  }

  return runWithLocale(locale, () => next());
}

/** Fire-and-forget activity histogram, feeding peak-hour reminders later. */
export async function activityTracker(ctx: BotContext, next: NextFunction): Promise<void> {
  const userId = ctx.session.userId;
  if (userId !== undefined) {
    void touchActivity(userId, new Date().getUTCHours()).catch((error: unknown) =>
      log.debug('Activity tracking failed', { userId, error }),
    );
  }
  return next();
}

const MEMBER_STATUSES = new Set(['creator', 'administrator', 'member', 'restricted']);

/**
 * Force-join gate.
 *
 * `/start` is exempt so a brand-new user sees a welcome and a join button
 * rather than a bare refusal, and the membership check callback is exempt for
 * the obvious reason that it is how they get through.
 */
export async function channelGuard(ctx: BotContext, next: NextFunction): Promise<void> {
  const channel = config().telegram.requiredChannel;
  if (!channel) return next();

  const text = ctx.message?.text ?? '';
  if (text.startsWith('/start') || ctx.callbackQuery?.data === 'chk') return next();

  if (await isMember(ctx, channel)) return next();

  await ctx.reply(t('channel.prompt'), {
    parse_mode: 'HTML',
    reply_markup: channelPromptKeyboard(channel),
  });
}

export async function isMember(ctx: BotContext, channel: string): Promise<boolean> {
  const userId = ctx.from?.id;
  if (userId === undefined) return false;

  try {
    const member = await ctx.api.getChatMember(channel, userId);
    return MEMBER_STATUSES.has(member.status);
  } catch (error) {
    // A misconfigured channel must not lock every user out of the bot.
    log.warn('Membership check failed; allowing through', { channel, error });
    return true;
  }
}
