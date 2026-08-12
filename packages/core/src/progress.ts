import { BOX_INTERVAL_DAYS, type Box } from './leitner.js';

/**
 * Progress & mastery math — the SINGLE place any of this lives.
 *
 * v1 reported one number: `Σ boxWeight / 2800 × 100`. Two problems with it.
 *
 * First, dividing by the whole NGSL list means a user who has genuinely
 * mastered 100 words sees 3.5%. That conflates *coverage* (how far through the
 * list you are) with *mastery* (how well you know what you've studied), and
 * reports the demotivating one as the headline.
 *
 * Second, it treats a box-5 word reviewed yesterday and a box-5 word 60 days
 * overdue as identical. The entire premise of a Leitner system is that memory
 * decays, so the score should too.
 *
 * The fix is an exponential forgetting curve on top of the box weight, reported
 * as several numbers that each answer a different question. Crucially, the
 * headline (`wordsLearned`) is monotonic — decay surfaces as "N words need a
 * refresh", an action, rather than as a percentage that falls while you sleep.
 */

export const BOX_WEIGHT: Readonly<Record<Box, number>> = {
  1: 0.2,
  2: 0.4,
  3: 0.6,
  4: 0.8,
  5: 1.0,
};

/** Below this, a word is considered stale and shows up in "needs refresh". */
export const REFRESH_THRESHOLD = 0.5;

const DAY_MS = 86_400_000;

export function daysSince(from: Date, now: Date): number {
  return Math.max(0, (now.getTime() - from.getTime()) / DAY_MS);
}

/**
 * Recall probability under an exponential forgetting curve whose half-life is
 * the box's own review interval: 1.0 immediately after review, exactly 0.5 when
 * the word falls due, decaying afterwards.
 */
export function retention(box: Box, daysSinceReview: number): number {
  const halfLife = BOX_INTERVAL_DAYS[box];
  return Math.min(1, 2 ** (-Math.max(0, daysSinceReview) / halfLife));
}

/** A word's live contribution: box weight discounted by staleness. Range [0, 1]. */
export function strength(box: Box, daysSinceReview: number): number {
  return BOX_WEIGHT[box] * retention(box, daysSinceReview);
}

export interface ProgressInput {
  box: Box;
  /** Falls back to first-seen for a word that has never been reviewed. */
  lastReviewedAt: Date | null;
  firstSeenAt: Date;
}

export interface ProgressSummary {
  /** Monotonic headline — never decreases. */
  wordsLearned: number;
  /** How solid the user's knowledge is, over what they have actually studied. */
  masteryPercent: number;
  /** v1's number, preserved: share of the whole NGSL list, retention-weighted. */
  ngslProgressPercent: number;
  /** Actionable decay signal; feeds the daily quests. */
  needsRefresh: number;
  /** Raw weighted sum, kept for the leaderboard and analytics. */
  masteryScore: number;
  byBox: Record<Box, number>;
}

export function summarizeProgress(
  words: readonly ProgressInput[],
  totalWords: number,
  now: Date = new Date(),
): ProgressSummary {
  const byBox: Record<Box, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let masteryScore = 0;
  let needsRefresh = 0;

  for (const w of words) {
    byBox[w.box] += 1;
    const s = strength(w.box, daysSince(w.lastReviewedAt ?? w.firstSeenAt, now));
    masteryScore += s;
    if (s < REFRESH_THRESHOLD) needsRefresh += 1;
  }

  const wordsLearned = words.length;
  return {
    wordsLearned,
    masteryScore,
    byBox,
    needsRefresh,
    masteryPercent: wordsLearned === 0 ? 0 : clampPercent((masteryScore / wordsLearned) * 100),
    ngslProgressPercent: totalWords === 0 ? 0 : clampPercent((masteryScore / totalWords) * 100),
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** 10-cell bar, ported from v1's progress screen. */
export function progressBar(percent: number, length = 10): string {
  const filled = Math.round((clampPercent(percent) / 100) * length);
  return '▓'.repeat(filled) + '░'.repeat(length - filled);
}
