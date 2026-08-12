/**
 * Point values.
 *
 * The ledger is append-only, so these are the only place a score is decided and
 * every balance is a `SUM` over a window. Nothing mutates a running total,
 * which keeps the whole system auditable — a wrong leaderboard can always be
 * traced back to the rows that produced it.
 */

export type PointReason =
  | 'new_word'
  | 'review_correct'
  | 'writing_submitted'
  | 'clip_watched'
  | 'daily_goal'
  | 'streak_milestone'
  | 'quest_bonus';

/**
 * Weighted by effort, not by ease of triggering. Writing is worth ten reviews
 * because it is the hardest thing a learner can do here, and clips are worth
 * little precisely because tapping a button is not learning.
 */
export const POINT_VALUES: Readonly<Record<PointReason, number>> = {
  new_word: 10,
  review_correct: 5,
  writing_submitted: 50,
  clip_watched: 2,
  daily_goal: 25,
  streak_milestone: 100,
  quest_bonus: 30,
};

/**
 * Apply the streak multiplier.
 *
 * This is what makes a streak an asset rather than a trophy: at ×2 every action
 * is worth double, so breaking a 30-day streak has an ongoing cost. Milestone
 * bonuses are excluded — they are already a reward for the streak itself, and
 * multiplying them would compound the same thing twice.
 */
export function pointsFor(reason: PointReason, multiplier = 1): number {
  const base = POINT_VALUES[reason];
  if (reason === 'streak_milestone') return base;
  return Math.round(base * multiplier);
}
