import { Context, type Api } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext } from '../types.js';

/**
 * The boards open from three places: a menu button and a command (both plain
 * messages) and the buttons under another board (a callback query). Only the
 * last one carries a query to acknowledge.
 */

vi.mock('@ngsl/db', () => ({
  currentMembership: vi.fn(() => Promise.resolve(undefined)),
  globalLeaderboard: vi.fn(() => Promise.resolve([])),
  globalRank: vi.fn(() => Promise.resolve(undefined)),
  lazyBoard: vi.fn(() => Promise.resolve([])),
}));

vi.mock('@ngsl/shared', () => ({
  config: () => ({ app: { timezone: 'Asia/Tehran' } }),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { globalBoardHandler, lazyBoardHandler, leagueHandler } = await import('./game.js');

const me = { id: 1, is_bot: true, first_name: 'bot', username: 'bot' } as UserFromGetMe;
const from = { id: 42, is_bot: false, first_name: 'Sara' };
const chat = { id: 42, type: 'private' as const, first_name: 'Sara' };

function contextFor(update: Update) {
  const answerCallbackQuery = vi.fn(() => Promise.resolve(true));
  const api = { answerCallbackQuery } as unknown as Api;
  const ctx = new Context(update, api, me) as BotContext;
  ctx.session = { reviewQueue: [], reviewAnswered: 0, userId: 7 };
  const reply = vi.fn(() => Promise.resolve({}));
  ctx.reply = reply as unknown as BotContext['reply'];
  return { ctx, reply, answerCallbackQuery };
}

const fromMenu = () =>
  contextFor({
    update_id: 1,
    message: { message_id: 1, date: 0, chat, from, text: '🏆 League' },
  });

const fromButton = () =>
  contextFor({
    update_id: 2,
    callback_query: {
      id: 'q1',
      from,
      chat_instance: 'c',
      data: 'league',
      message: { message_id: 2, date: 0, chat, text: 'board' },
    },
  });

const BOARDS = [
  ['league', leagueHandler],
  ['all-time', globalBoardHandler],
  ['Lazy Board', lazyBoardHandler],
] as const;

describe('board handlers', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(BOARDS)('the %s board answers a menu button or a command', async (_name, handler) => {
    const { ctx, reply, answerCallbackQuery } = fromMenu();
    await handler(ctx);
    expect(reply).toHaveBeenCalledOnce();
    expect(answerCallbackQuery).not.toHaveBeenCalled();
  });

  it.each(BOARDS)('the %s board acknowledges a button under another board', async (_name, handler) => {
    const { ctx, reply, answerCallbackQuery } = fromButton();
    await handler(ctx);
    expect(answerCallbackQuery).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
  });
});
