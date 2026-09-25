import { flagBlocked } from '@ngsl/db';
import { config, createLogger } from '@ngsl/shared';
import { Bot, GrammyError, type InlineKeyboard } from 'grammy';

/** Bulk sends from the worker: reminders, motivation, nightly boards. */

const log = createLogger('worker.dispatch');

/** Same pacing rationale as the broadcast: stay well under ~30 msg/s. */
const SEND_INTERVAL_MS = 45;

let bot: Bot | undefined;
function api(): Bot {
  bot ??= new Bot(config().telegram.botToken);
  return bot;
}

export interface DispatchTarget {
  userId: number;
  telegramId: number;
}

export interface DispatchResult {
  audience: number;
  sent: number;
}

/**
 * Send one HTML message. A 403 or 400 means the user blocked the bot or the chat
 * is gone, so they are flagged and later bulk sends skip them. A 429 is
 * Telegram's flood control: wait the `retry_after` it names, then try once more.
 */
export async function deliver(
  target: DispatchTarget,
  text: string,
  keyboard?: InlineKeyboard,
  retried = false,
): Promise<boolean> {
  try {
    await api().api.sendMessage(target.telegramId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    return true;
  } catch (error) {
    if (error instanceof GrammyError && error.error_code === 429 && !retried) {
      const seconds = error.parameters.retry_after ?? 5;
      log.warn('Flood control; waiting before retrying', { userId: target.userId, seconds });
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return deliver(target, text, keyboard, true);
    }
    if (error instanceof GrammyError && (error.error_code === 403 || error.error_code === 400)) {
      await flagBlocked(target.telegramId).catch(() => undefined);
    } else {
      log.warn('Send failed', { userId: target.userId, error });
    }
    return false;
  }
}

export function pace(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
}
