import { remainingToday } from '@ngsl/core';
import {
  getDailyLimits,
  getDueWords,
  selectNewWords,
  type ReviewCard,
  type WordCard,
} from '@ngsl/db';
import { createLogger } from '@ngsl/shared';
import { prewarmWords } from './video-render.queue.js';

const log = createLogger('queue.session');

/**
 * Session assembly — the seam where the learning engine meets the clip pipeline.
 *
 * It lives in `@ngsl/queue` rather than `@ngsl/db` for one reason: starting a
 * session must enqueue render jobs, and the persistence layer has no business
 * knowing about Redis.
 */

export interface NewWordSession {
  words: WordCard[];
  /** Remaining allowance after this batch — drives "you've hit today's goal". */
  remaining: number;
  limitReached: boolean;
  rendersQueued: number;
}

export interface ReviewSession {
  words: ReviewCard[];
  remaining: number;
  limitReached: boolean;
  rendersQueued: number;
}

/**
 * Start a new-words session.
 *
 * The daily allowance is the user's own `daily_new_target`, minus what they have
 * already learned since local midnight — so the cap survives the bot restarting,
 * and lowering the target mid-day stops the session rather than going negative.
 *
 * The words are chosen here but NOT added to the deck: the bot shows them one
 * card at a time and adds each word when its card appears. A learner who stops
 * halfway keeps only the words they saw, and the rest of the day's allowance
 * is still there for the next session.
 */
export async function startNewWordSession(userId: number): Promise<NewWordSession> {
  const limits = await getDailyLimits(userId);
  const allowance = remainingToday(limits.newTarget, limits.newDoneToday);

  if (allowance === 0) {
    return { words: [], remaining: 0, limitReached: true, rendersQueued: 0 };
  }

  const words = await selectNewWords(userId, allowance);
  if (words.length === 0) {
    return { words: [], remaining: allowance, limitReached: false, rendersQueued: 0 };
  }

  // Fire-and-forget: the learner should never wait on Redis to see their words.
  // Failures are logged, not surfaced — a missing clip degrades the card, it
  // does not break the session.
  const rendersQueued = await prewarmWords(words.map((w) => w.wordId)).catch((error: unknown) => {
    log.warn('Session pre-warm failed', { userId, error });
    return 0;
  });

  return {
    words,
    remaining: remainingToday(allowance, words.length),
    limitReached: false,
    rendersQueued,
  };
}

/**
 * Start a review session.
 *
 * Review words are already in the deck, so their clips are usually rendered —
 * but a word reviewed for the second time needs FIVE clips it has not seen yet,
 * which may not exist. Pre-warming here is what keeps that promise.
 */
export async function startReviewSession(userId: number): Promise<ReviewSession> {
  const limits = await getDailyLimits(userId);
  const allowance = remainingToday(limits.reviewTarget, limits.reviewDoneToday);

  if (allowance === 0) {
    return { words: [], remaining: 0, limitReached: true, rendersQueued: 0 };
  }

  const words = await getDueWords(userId, allowance);
  if (words.length === 0) {
    return { words: [], remaining: allowance, limitReached: false, rendersQueued: 0 };
  }

  const rendersQueued = await prewarmWords(words.map((w) => w.wordId)).catch((error: unknown) => {
    log.warn('Session pre-warm failed', { userId, error });
    return 0;
  });

  return { words, remaining: allowance, limitReached: false, rendersQueued };
}
