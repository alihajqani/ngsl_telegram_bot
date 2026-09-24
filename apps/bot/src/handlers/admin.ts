import { adminStats, broadcastAudience, flagBlocked } from '@ngsl/db';
import { config, createLogger } from '@ngsl/shared';
import { GrammyError, InlineKeyboard } from 'grammy';
import { escapeHtml, runWithLocale, t } from '../i18n/i18n.js';
import { CB } from '../keyboards.js';
import type { BotContext } from '../types.js';

const log = createLogger('bot.admin');

/**
 * Telegram tolerates roughly 30 messages/second across different chats. Pacing
 * at 40ms keeps a broadcast comfortably under that; going faster earns a 429
 * that stalls the whole bot, not just the broadcast.
 */
const SEND_INTERVAL_MS = 40;
const PROGRESS_EVERY = 250;

export function isAdmin(ctx: BotContext): boolean {
  const id = ctx.from?.id;
  return id !== undefined && config().telegram.adminIds.includes(id);
}

export async function adminHandler(ctx: BotContext): Promise<void> {
  if (!isAdmin(ctx)) return;

  const stats = await adminStats();
  await ctx.reply(
    [
      '🛠 <b>Admin</b>',
      '',
      `👥 users: <b>${stats.users}</b>  (today ${stats.activeToday}, week ${stats.activeWeek})`,
      `🚫 blocked: ${stats.blocked}`,
      `📚 words in decks: <b>${stats.wordsLearned}</b>`,
      `⭐ points awarded: <b>${stats.pointsAwarded}</b>`,
      `🎬 clips rendered: <b>${stats.renderedClips}</b>`,
      `📺 videos: ${stats.liveVideos} live / ${stats.deadVideos} dead`,
    ].join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('📣 Broadcast', CB.broadcast),
    },
  );
}

export async function adminBroadcastPromptHandler(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!isAdmin(ctx)) return;

  ctx.session.awaitingBroadcast = true;
  await ctx.reply('📣 Send the message to broadcast.', {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('❌ Cancel', CB.broadcastCancel),
  });
}

/** The prompt's cancel button; typing /cancel still works too. */
export async function adminBroadcastCancelHandler(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!isAdmin(ctx) || !ctx.session.awaitingBroadcast) return;

  ctx.session.awaitingBroadcast = false;
  await ctx.editMessageReplyMarkup().catch(() => undefined);
  await ctx.reply('Broadcast cancelled.');
}

/** True when this text message is the pending broadcast body. */
export function isAwaitingBroadcast(ctx: BotContext): boolean {
  return ctx.session.awaitingBroadcast === true && isAdmin(ctx);
}

/**
 * Fan a message out to every non-blocked user.
 *
 * Detached on purpose: a 10,000-user broadcast takes minutes, and awaiting it
 * would hold the update handler open for the entire run. Each recipient is
 * rendered in their own locale, and a 403 flags them as blocked so the next
 * broadcast skips them automatically.
 */
export async function broadcastHandler(ctx: BotContext): Promise<void> {
  if (!isAwaitingBroadcast(ctx)) return;
  const body = ctx.message?.text;
  if (!body) return;

  ctx.session.awaitingBroadcast = false;

  if (body.trim() === '/cancel') {
    await ctx.reply('Broadcast cancelled.');
    return;
  }

  const audience = await broadcastAudience();
  const status = await ctx.reply(`📣 Broadcasting to ${audience.length} users…`);

  void (async () => {
    let ok = 0;
    let failed = 0;

    for (const [index, recipient] of audience.entries()) {
      try {
        await ctx.api.sendMessage(recipient.telegramId, body, { parse_mode: 'HTML' });
        ok += 1;
      } catch (error) {
        failed += 1;
        if (error instanceof GrammyError && (error.error_code === 403 || error.error_code === 400)) {
          await flagBlocked(recipient.telegramId).catch(() => undefined);
        }
      }

      if ((index + 1) % PROGRESS_EVERY === 0) {
        await ctx.api
          .editMessageText(
            status.chat.id,
            status.message_id,
            `📣 ${index + 1}/${audience.length} — ✅ ${ok} ❌ ${failed}`,
          )
          .catch(() => undefined);
      }

      await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
    }

    await ctx.api
      .editMessageText(
        status.chat.id,
        status.message_id,
        `📣 <b>Broadcast complete</b>\n✅ delivered ${ok}\n❌ failed ${failed}`,
        { parse_mode: 'HTML' },
      )
      .catch(() => undefined);

    log.info('Broadcast finished', { ok, failed, total: audience.length });
  })();
}

/** Localized helper for future admin messages sent to individual users. */
export async function replyLocalized(
  ctx: BotContext,
  telegramId: number,
  locale: 'fa' | 'en',
  key: string,
): Promise<void> {
  await runWithLocale(locale, async () => {
    await ctx.api
      .sendMessage(telegramId, escapeHtml(t(key)), { parse_mode: 'HTML' })
      .catch(() => undefined);
  });
}
