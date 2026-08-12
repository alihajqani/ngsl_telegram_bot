import { getDailyLimits, getDueWords, getWordLemma, recordReview } from '@ngsl/db';
import { startNewWordSession, startReviewSession } from '@ngsl/queue';
import { recordActivity, type ActivityResult } from '@ngsl/game';
import { createLogger } from '@ngsl/shared';
import { t } from '../i18n/i18n.js';
import { reviewCardKeyboard, wordCardKeyboard } from '../keyboards.js';
import type { BotContext } from '../types.js';
import { buildAnswerFeedback, buildReviewCard, buildWordCard } from './cards.js';

const log = createLogger('bot.sessions');

/**
 * `/newwords`.
 *
 * The session layer has already enforced the user's daily allowance, persisted
 * the words and enqueued their clip renders at session priority — this handler
 * only presents the result.
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

  await ctx.reply(t('newWords.header', { count: session.words.length }), { parse_mode: 'HTML' });

  // One card per word: each carries its own examples, collocations and clips.
  for (const word of session.words) {
    await ctx.reply(buildWordCard(word), {
      parse_mode: 'HTML',
      reply_markup: wordCardKeyboard(word.wordId, word.lemma),
    });
  }

  // Gamification runs after the cards are delivered: a points failure must never
  // cost the learner their words.
  await awardQuietly(ctx, 'new_word', session.words.length);

  await ctx.reply(t('newWords.done'), { parse_mode: 'HTML' });
  log.info('New word session served', {
    userId,
    words: session.words.length,
    rendersQueued: session.rendersQueued,
  });
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


/**
 * Award points and surface streak news, without ever letting gamification break
 * a learning flow.
 */
export async function awardQuietly(
  ctx: BotContext,
  reason: 'new_word' | 'review_correct' | 'clip_watched' | 'writing_submitted',
  times = 1,
  refId?: number,
): Promise<void> {
  const userId = ctx.session.userId;
  if (userId === undefined) return;

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
    if (!first) return;

    const notes: string[] = [];
    if (first.streak.freezesUsed > 0) notes.push(t('game.freezeUsed'));
    if (first.streak.milestone !== null) {
      notes.push(
        t('game.milestone', { days: first.streak.milestone, bonus: first.milestoneBonus }),
      );
    }
    notes.push(t('game.earned', { points: earned }));

    await ctx.reply(notes.join('\n'), { parse_mode: 'HTML' });
  } catch (error) {
    log.warn('Awarding points failed', { userId, reason, error });
  }
}
