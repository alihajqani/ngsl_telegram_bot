import { countDeck } from '@ngsl/db';
import { config } from '@ngsl/shared';
import { t } from '../i18n/i18n.js';
import { channelPromptKeyboard, mainMenuKeyboard } from '../keyboards.js';
import { isMember } from '../middlewares.js';
import type { BotContext } from '../types.js';
import { isAdmin } from './admin.js';
import { tryAcceptBuddy } from './game.js';

const NGSL_SIZE = 2809;

/**
 * `/start`.
 *
 * Exempt from the channel guard, so this is where a non-member is invited
 * rather than refused — the difference between an onboarding step and a wall.
 */
export async function startHandler(ctx: BotContext): Promise<void> {
  const channel = config().telegram.requiredChannel;

  if (channel && !(await isMember(ctx, channel))) {
    await ctx.reply(t('channel.prompt'), {
      parse_mode: 'HTML',
      reply_markup: channelPromptKeyboard(channel),
    });
    return;
  }

  // `/start buddy_<id>` — accepting a buddy invitation. Handled here because a
  // deep link is how an invitee first arrives, often before they have a profile.
  const payload = ctx.message?.text?.split(' ').slice(1).join(' ').trim();
  if (payload) await tryAcceptBuddy(ctx, payload);

  await sendWelcome(ctx);
}

export async function sendWelcome(ctx: BotContext): Promise<void> {
  await ctx.reply(
    t('start.welcome', {
      name: ctx.from?.first_name ?? '',
      wordCount: NGSL_SIZE,
    }),
    { parse_mode: 'HTML' },
  );

  await ctx.reply(t('start.guide'), {
    parse_mode: 'HTML',
    reply_markup: mainMenuKeyboard({ admin: isAdmin(ctx) }),
  });
}

/** The "I have joined" button. */
export async function checkMembershipHandler(ctx: BotContext): Promise<void> {
  const channel = config().telegram.requiredChannel;
  if (!channel) return;

  if (!(await isMember(ctx, channel))) {
    await ctx.answerCallbackQuery({ text: t('channel.notJoined'), show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: t('channel.joined') });
  await sendWelcome(ctx);
}

/** Progress screen — the retention-aware summary from `@ngsl/core`. */
export async function progressHandler(ctx: BotContext): Promise<void> {
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  const { getProgressInputs } = await import('@ngsl/db');
  const { progressBar, summarizeProgress } = await import('@ngsl/core');

  const summary = summarizeProgress(await getProgressInputs(userId), NGSL_SIZE);
  const deck = await countDeck(userId);

  await ctx.reply(
    `${t('progress.header')}\n\n` +
      t('progress.body', {
        bar: progressBar(summary.ngslProgressPercent),
        percent: summary.ngslProgressPercent.toFixed(1),
        learned: deck,
        mastery: summary.masteryPercent.toFixed(0),
        refresh: summary.needsRefresh,
        total: NGSL_SIZE,
      }),
    { parse_mode: 'HTML' },
  );
}
