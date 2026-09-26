import {
  addNewWords,
  getDailyLimits,
  getDueWords,
  getWordCard,
  getWordLemma,
  recordReview,
} from '@ngsl/db';
import { startNewWordSession, startReviewSession } from '@ngsl/queue';
import { recordActivity, type ActivityResult } from '@ngsl/game';
import { reportFeature } from '@ngsl/monitor';
import { createLogger } from '@ngsl/shared';
import { t } from '../i18n/i18n.js';
import {
  CB_PATTERN,
  reviewCardKeyboard,
  withoutNextWord,
  wordCardKeyboard,
} from '../keyboards.js';
import type { BotContext, NewWordDeckState } from '../types.js';
import { buildAnswerFeedback, buildReviewCard, buildWordCard } from './cards.js';

const log = createLogger('bot.sessions');

/**
 * `/newwords`.
 *
 * The session layer has already enforced the user's daily allowance, chosen
 * the words and enqueued their clip renders at session priority. The cards
 * then come one at a time, each with a button to the next, so a batch of
 * twenty is not twenty messages at once.
 */
export async function newWordsHandler(ctx: BotContext): Promise<void> {
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  const session = await startNewWordSession(userId);

  if (session.limitReached) {
    const limits = await getDailyLimits(userId);
    await ctx.reply(t('newWords.limitReached', { target: limits.newTarget }), {
      parse_mode: 'HTML',
    });
    return;
  }

  if (session.words.length === 0) {
    await ctx.reply(t('newWords.allSeen'), { parse_mode: 'HTML' });
    return;
  }

  // A new session replaces any unfinished one: its unseen words were never
  // added to the deck, so nothing is lost.
  ctx.session.newWordDeck = {
    queue: session.words.map((w) => w.wordId),
    total: session.words.length,
    earned: 0,
  };

  await ctx.reply(t('newWords.header', { count: session.words.length }), { parse_mode: 'HTML' });
  await sendNextWordCard(ctx);
  if (ctx.from) reportFeature('newwords', ctx.from, `${session.words.length} words`);
  log.info('New word session started', {
    userId,
    words: session.words.length,
    rendersQueued: session.rendersQueued,
  });
}

/**
 * The "next word" button (`nx:<wordId>`).
 *
 * Only the card on screen moves the session on. A double tap, or the button
 * on a card from an earlier session, just loses its button.
 */
export async function nextWordHandler(ctx: BotContext): Promise<void> {
  const match = CB_PATTERN.nextWord.exec(ctx.callbackQuery?.data ?? '');
  const deck = ctx.session.newWordDeck;
  const live = match !== null && deck?.current === Number(match[1]);

  await ctx.answerCallbackQuery(
    deck ? undefined : { text: t('newWords.ended', { button: t('menu.newWords') }) },
  );

  const message = ctx.callbackQuery?.message;
  if (message && 'reply_markup' in message && message.reply_markup) {
    await ctx
      .editMessageReplyMarkup({
        reply_markup: { inline_keyboard: withoutNextWord(message.reply_markup.inline_keyboard) },
      })
      .catch(() => undefined);
  }

  if (live) await sendNextWordCard(ctx);
}

/**
 * Show the card at the head of the session, adding its word to the deck.
 * The last card closes the session with the points it earned.
 */
async function sendNextWordCard(ctx: BotContext): Promise<void> {
  const userId = ctx.session.userId;
  const deck = ctx.session.newWordDeck;
  if (userId === undefined || !deck) return;

  const [wordId, ...rest] = deck.queue;
  if (wordId === undefined) return finishNewWords(ctx, deck);

  const word = await getWordCard(wordId);
  if (!word) {
    ctx.session.newWordDeck = { ...deck, queue: rest };
    return sendNextWordCard(ctx);
  }

  // Into the deck before the card goes out: a word the learner has seen must
  // come back for review, even if something after this line fails.
  const added = await addNewWords(userId, [wordId]);

  await ctx.reply(buildWordCard(word), {
    parse_mode: 'HTML',
    reply_markup: wordCardKeyboard(
      word.wordId,
      word.lemma,
      rest.length > 0 ? { position: deck.total - rest.length + 1, total: deck.total } : undefined,
    ),
  });

  // Gamification runs after the card is delivered: a points failure must never
  // cost the learner their word. A word already in the deck earns nothing.
  const award = added > 0 ? await recordQuietly(ctx, 'new_word', 1, wordId) : undefined;
  if (award && award.notes.length > 0) {
    await ctx.reply(award.notes.join('\n'), { parse_mode: 'HTML' }).catch(() => undefined);
  }

  const next = { ...deck, queue: rest, current: wordId, earned: deck.earned + (award?.earned ?? 0) };
  if (rest.length > 0) ctx.session.newWordDeck = next;
  else await finishNewWords(ctx, next);
}

async function finishNewWords(ctx: BotContext, deck: NewWordDeckState): Promise<void> {
  ctx.session.newWordDeck = undefined;
  const lines = [t('newWords.done')];
  if (deck.earned > 0) lines.unshift(t('game.earned', { points: deck.earned }));
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  log.info('New word session finished', { userId: ctx.session.userId, words: deck.total });
}

/**
 * `/review`.
 *
 * Unlike new words, review is strictly one card at a time: the learner must
 * answer before the next appears, otherwise the Leitner signal is meaningless.
 * The queue lives in the session; the boxes live in Postgres.
 */
export async function reviewHandler(ctx: BotContext): Promise<void> {
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  const session = await startReviewSession(userId);

  if (session.limitReached) {
    const limits = await getDailyLimits(userId);
    await ctx.reply(t('review.limitReached', { target: limits.reviewTarget }), {
      parse_mode: 'HTML',
    });
    return;
  }

  if (session.words.length === 0) {
    await ctx.reply(t('review.empty'), { parse_mode: 'HTML' });
    return;
  }

  ctx.session.reviewQueue = session.words.map((w) => w.wordId);
  ctx.session.reviewAnswered = 0;

  await ctx.reply(t('review.header', { count: session.words.length }), { parse_mode: 'HTML' });
  await sendNextReviewCard(ctx);
  if (ctx.from) reportFeature('review', ctx.from, `${session.words.length} due`);
}

/** Send the card at the head of the queue, or close the session. */
export async function sendNextReviewCard(ctx: BotContext): Promise<void> {
  const userId = ctx.session.userId;
  const queue = ctx.session.reviewQueue;

  if (userId === undefined || queue.length === 0) {
    if (ctx.session.reviewAnswered > 0) {
      await ctx.reply(t('review.sessionDone', { count: ctx.session.reviewAnswered }), {
        parse_mode: 'HTML',
      });
      ctx.session.reviewAnswered = 0;
    }
    return;
  }

  // Re-read from the database rather than caching cards in the session: the box
  // may have changed, and the session should never be a second source of truth.
  const due = await getDueWords(userId, 50);
  const next = due.find((w) => w.wordId === queue[0]);

  if (!next) {
    // No longer due — drop it and move on rather than stalling the queue.
    ctx.session.reviewQueue = queue.slice(1);
    return sendNextReviewCard(ctx);
  }

  await ctx.reply(buildReviewCard(next, queue.length - 1), {
    parse_mode: 'HTML',
    reply_markup: reviewCardKeyboard(next.wordId, next.lemma),
  });
}

const RESULTS = { c: 'correct', w: 'wrong', k: 'known' } as const;

/** Handle a Leitner answer button. */
export async function reviewAnswerHandler(ctx: BotContext): Promise<void> {
  const match = /^rv:([cwk]):(\d+)$/.exec(ctx.callbackQuery?.data ?? '');
  const userId = ctx.session.userId;
  if (!match || userId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }

  const result = RESULTS[match[1] as keyof typeof RESULTS];
  const wordId = Number(match[2]);

  // Acknowledge first so the client stops spinning even if the write is slow.
  await ctx.answerCallbackQuery();

  const outcome = await recordReview(userId, wordId, result);
  if (!outcome) {
    await ctx.reply(t('errors.session'), { parse_mode: 'HTML' });
    return;
  }

  // The word is no longer due now that it has been answered, so it cannot be
  // found via getDueWords — look the lemma up directly.
  const lemma = (await getWordLemma(wordId)) ?? '';

  // Strip the answer buttons so a double-tap cannot re-answer the same card.
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);

  await ctx.reply(
    buildAnswerFeedback(result, lemma, outcome.boxAfter, outcome.nextReviewAt),
    { parse_mode: 'HTML' },
  );

  // Only a correct recall earns points; a wrong answer is still progress but
  // paying for it would make the leaderboard reward volume over accuracy.
  if (result === 'correct') await awardQuietly(ctx, 'review_correct', 1, wordId);

  ctx.session.reviewQueue = ctx.session.reviewQueue.filter((id) => id !== wordId);
  ctx.session.reviewAnswered += 1;
  await sendNextReviewCard(ctx);
}


type AwardReason = 'new_word' | 'review_correct' | 'clip_watched' | 'writing_submitted';

/**
 * Award points and surface streak news, without ever letting gamification break
 * a learning flow.
 */
export async function awardQuietly(
  ctx: BotContext,
  reason: AwardReason,
  times = 1,
  refId?: number,
): Promise<void> {
  const award = await recordQuietly(ctx, reason, times, refId);
  if (!award) return;

  const lines = [...award.notes, t('game.earned', { points: award.earned })];
  await ctx
    .reply(lines.join('\n'), { parse_mode: 'HTML' })
    .catch((error: unknown) =>
      log.warn('Points message failed', { userId: ctx.session.userId, reason, error }),
    );
}

/**
 * Record the points without announcing them. `notes` holds the streak news
 * (a freeze used, a milestone), which only the day's first award can carry.
 */
async function recordQuietly(
  ctx: BotContext,
  reason: AwardReason,
  times = 1,
  refId?: number,
): Promise<{ earned: number; notes: string[] } | undefined> {
  const userId = ctx.session.userId;
  if (userId === undefined) return undefined;

  try {
    let earned = 0;
    // Streak news can only come from the FIRST award: recordStudyDay is
    // idempotent within a day, so every later call reports an unchanged streak.
    let first: ActivityResult | undefined;

    for (let i = 0; i < times; i++) {
      const result = await recordActivity(userId, reason, refId);
      earned += result.points + result.milestoneBonus;
      first ??= result;
    }
    if (!first) return undefined;

    const notes: string[] = [];
    if (first.streak.freezesUsed > 0) notes.push(t('game.freezeUsed'));
    if (first.streak.milestone !== null) {
      notes.push(
        t('game.milestone', { days: first.streak.milestone, bonus: first.milestoneBonus }),
      );
    }
    return { earned, notes };
  } catch (error) {
    log.warn('Awarding points failed', { userId, reason, error });
    return undefined;
  }
}
