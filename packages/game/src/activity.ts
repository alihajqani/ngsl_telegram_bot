import {
  dayKey,
  pointsFor,
  recordStudyDay,
  weekStartKey,
  type PointReason,
  type StreakTransition,
} from '@ngsl/core';
import {
  addLeaguePoints,
  awardPoints,
  currentMembership,
  findOrCreateLeague,
  getStreak,
  joinLeague,
  saveStreak,
} from '@ngsl/db';
import { config, createLogger } from '@ngsl/shared';

const log = createLogger('game.activity');

/**
 * The single entry point for "the learner did something that counts".
 *
 * Everything gamified flows through here: the streak advances at most once a
 * day, the resulting multiplier is applied to the award, and the points land in
 * the append-only ledger and the current league standing together. Handlers
 * never compute points themselves.
 */

export interface ActivityResult {
  points: number;
  streak: StreakTransition;
  /** Bonus awarded when this activity crossed a streak milestone. */
  milestoneBonus: number;
}

/**
 * Record a qualifying activity.
 *
 * The streak is advanced *before* the award so a learner who starts a new day
 * with a review immediately gets that day's multiplier — the alternative would
 * quietly under-pay the first action of every session.
 */
export async function recordActivity(
  userId: number,
  reason: PointReason,
  refId?: number,
): Promise<ActivityResult> {
  const timezone = config().app.timezone;
  const today = dayKey(new Date(), timezone);

  const before = await getStreak(userId);
  const streak = recordStudyDay(before, today);
  if (streak.changed) {
    await saveStreak(userId, {
      current: streak.current,
      longest: streak.longest,
      lastStudyDay: streak.lastStudyDay,
      freezesAvailable: streak.freezesAvailable,
      multiplier: streak.multiplier,
    });
  }

  const multiplier = streak.changed ? streak.multiplier : before.multiplier;
  const points = pointsFor(reason, multiplier);

  const leagueId = await ensureLeagueMembership(userId, today);
  await grant(userId, points, reason, leagueId, refId);

  let milestoneBonus = 0;
  if (streak.milestone !== null) {
    milestoneBonus = pointsFor('streak_milestone');
    await grant(userId, milestoneBonus, 'streak_milestone', leagueId, streak.milestone);
    log.info('Streak milestone reached', { userId, milestone: streak.milestone });
  }

  return { points, streak, milestoneBonus };
}

/** Ledger and league standing move together, so a board can never drift. */
async function grant(
  userId: number,
  points: number,
  reason: PointReason,
  leagueId: number | undefined,
  refId?: number,
): Promise<void> {
  await awardPoints(userId, points, reason, refId);
  if (leagueId !== undefined) await addLeaguePoints(leagueId, userId, points);
}

/**
 * Place a learner in this week's bottom-tier league on first activity.
 *
 * Joining lazily rather than by a Saturday sweep means a user who signs up
 * mid-week competes immediately instead of waiting six days to be seeded.
 */
export async function ensureLeagueMembership(
  userId: number,
  today: string,
): Promise<number | undefined> {
  const weekStart = weekStartKey(today);
  const existing = await currentMembership(userId, weekStart);
  if (existing) return existing.leagueId;

  const leagueId = await findOrCreateLeague(1, weekStart);
  await joinLeague(leagueId, userId);
  return leagueId;
}
