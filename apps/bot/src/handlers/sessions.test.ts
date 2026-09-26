import { Context, type Api } from 'grammy';
import type { InlineKeyboardMarkup, Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithLocale } from '../i18n/i18n.js';
import type { BotContext, SessionData } from '../types.js';

/**
 * New words come one card at a time: each card carries the button to the next,
 * and a word joins the deck only when its card is shown.
 */

const addNewWords = vi.fn((_userId: number, ids: readonly number[]) => Promise.resolve(ids.length));
const startNewWordSession = vi.fn();
const recordActivity = vi.fn(() =>
  Promise.resolve({ points: 10, milestoneBonus: 0, streak: { freezesUsed: 0, milestone: null } }),
);

vi.mock('@ngsl/db', () => ({
  addNewWords,
  getDailyLimits: vi.fn(),
  getDueWords: vi.fn(),
  getWordCard: (wordId: number) =>
    Promise.resolve({ wordId, lemma: `word${wordId}`, definition: null, bucket: 1 }),
  getWordLemma: vi.fn(),
  recordReview: vi.fn(),
}));
vi.mock('@ngsl/queue', () => ({ startNewWordSession, startReviewSession: vi.fn() }));
vi.mock('@ngsl/game', () => ({ recordActivity }));
const reportFeature = vi.fn();
vi.mock('@ngsl/monitor', () => ({ reportFeature }));
vi.mock('@ngsl/shared', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { newWordsHandler, nextWordHandler } = await import('./sessions.js');

const me = { id: 1, is_bot: true, first_name: 'bot', username: 'bot' } as UserFromGetMe;
const from = { id: 42, is_bot: false, first_name: 'Sara' };
const chat = { id: 42, type: 'private' as const, first_name: 'Sara' };

interface Sent {
  text: string;
  markup?: InlineKeyboardMarkup;
}

let session: SessionData;
let sent: Sent[];

function run(update: Update): Promise<void> {
  const api = {
    answerCallbackQuery: vi.fn(() => Promise.resolve(true)),
    editMessageReplyMarkup: vi.fn(() => Promise.resolve(true)),
  } as unknown as Api;
  const ctx = new Context(update, api, me) as BotContext;
  ctx.session = session;
  ctx.reply = ((text: string, other?: { reply_markup?: InlineKeyboardMarkup }) => {
    sent.push({ text, markup: other?.reply_markup });
    return Promise.resolve({});
  }) as unknown as BotContext['reply'];
  const handler = update.callback_query ? nextWordHandler : newWordsHandler;
  return runWithLocale('en', () => handler(ctx));
}

const menuTap = (): Update => ({
  update_id: 1,
  message: { message_id: 1, date: 0, chat, from, text: '📖 New words' },
});

const nextTap = (data: string): Update => ({
  update_id: 2,
  callback_query: {
    id: 'q',
    from,
    chat_instance: 'c',
    data,
    message: {
      message_id: 2,
      date: 0,
      chat,
      text: 'card',
      reply_markup: { inline_keyboard: [[{ text: 'Next', callback_data: data }]] },
    },
  },
});

const cards = () => sent.filter((m) => m.text.startsWith('<b>word'));
const nextButtons = (m: Sent) =>
  (m.markup?.inline_keyboard.flat() ?? []).flatMap((b) =>
    'callback_data' in b && b.callback_data?.startsWith('nx:') ? [b.callback_data] : [],
  );

beforeEach(() => {
  vi.clearAllMocks();
  session = { reviewQueue: [], reviewAnswered: 0, userId: 7 };
  sent = [];
  startNewWordSession.mockResolvedValue({
    words: [1, 2, 3].map((wordId) => ({ wordId, lemma: `word${wordId}`, definition: null, bucket: 1 })),
    remaining: 0,
    limitReached: false,
    rendersQueued: 0,
  });
});

describe('new-word session', () => {
  it('shows only the first card, with a button to the second', async () => {
    await run(menuTap());
    expect(cards().map((m) => m.text)).toEqual(['<b>word1</b>']);
    expect(nextButtons(cards()[0]!)).toEqual(['nx:1']);
    expect(addNewWords).toHaveBeenCalledTimes(1);
    expect(addNewWords).toHaveBeenLastCalledWith(7, [1]);
  });

  it('moves on one card per tap and closes with the points on the last one', async () => {
    await run(menuTap());
    await run(nextTap('nx:1'));
    await run(nextTap('nx:2'));

    expect(cards().map((m) => m.text)).toEqual(['<b>word1</b>', '<b>word2</b>', '<b>word3</b>']);
    expect(nextButtons(cards()[2]!)).toEqual([]);
    expect(sent.at(-1)?.text).toContain('+30 points');
    expect(recordActivity).toHaveBeenCalledTimes(3);
    expect(session.newWordDeck).toBeUndefined();
  });

  it('reports the session once to the monitor, not once per card', async () => {
    await run(menuTap());
    await run(nextTap('nx:1'));

    expect(reportFeature).toHaveBeenCalledTimes(1);
    expect(reportFeature).toHaveBeenCalledWith('newwords', from, '3 words');
  });

  it('ignores a second tap on a card it has already moved past', async () => {
    await run(menuTap());
    await run(nextTap('nx:1'));
    await run(nextTap('nx:1'));
    expect(cards()).toHaveLength(2);
  });

  it('adds nothing when the session is gone', async () => {
    await run(nextTap('nx:1'));
    expect(cards()).toHaveLength(0);
    expect(addNewWords).not.toHaveBeenCalled();
  });
});
