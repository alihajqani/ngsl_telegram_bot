import { dayKey, nextTier, resolveBuddyDay, resolveLeague, weekStartKey } from '@ngsl/core';
import {
  activeBuddyPairs,
  findOrCreateLeague,
  joinLeague,
  leagueStandings,
  leaguesForWeek,
  saveBuddyStreak,
  studiedOn,
} from '@ngsl/db';
import { config, createLogger } from '@ngsl/shared';

const log = createLogger('game.rollover');

export interface RolloverResult {
  weekClosed: string;
  weekOpened: string;
  leagues: number;
  promoted: number;
  demoted: number;
  held: number;
}

/**
 * Close last week's leagues and seed this week's.
 *
 * Runs on Monday. Every member of a closed cohort is placed into a new league
 * at their new tier, so nobody silently drops out of the competition — the most
 * common way a league system quietly dies.
 */
export async function runLeagueRollover(now: Date = new Date()): Promise<RolloverResult> {
  const timezone = config().app.timezone;
  const thisWeek = weekStartKey(dayKey(now, timezone));
  const lastWeek = weekStartKey(dayKey(new Date(now.getTime() - 7 * 86_400_000), timezone));

  const closing = await leaguesForWeek(lastWeek);
  const result: RolloverResult = {
    weekClosed: lastWeek,
    weekOpened: thisWeek,
    leagues: closing.length,
    promoted: 0,
    demoted: 0,
    held: 0,
  };

  for (const closed of closing) {
    const standings = await leagueStandings(closed.id);
    if (standings.length === 0) continue;

    const outcome = resolveLeague(standings, closed.tier);

    const moves: [number[], number][] = [
      [outcome.promote, nextTier(closed.tier, 'promote')],
      [outcome.demote, nextTier(closed.tier, 'demote')],
      [outcome.hold, closed.tier],
    ];

    for (const [userIds, tier] of moves) {
      if (userIds.length === 0) continue;
      const target = await findOrCreateLeague(tier, thisWeek);
      for (const userId of userIds) await joinLeague(target, userId);
    }

    result.promoted += outcome.promote.length;
    result.demoted += outcome.demote.length;
    result.held += outcome.hold.length;
  }

  log.info('League rollover complete', { ...result });
  return result;
}

export interface BuddyReconciliation {
  pairs: number;
  advanced: number;
  broken: number;
}

/**
 * Reconcile buddy streaks for a completed day.
 *
 * A joint streak needs both partners' activity, which cannot be known until the
 * day is over — so unlike personal streaks this genuinely requires a nightly
 * pass rather than lazy evaluation.
 */
export async function reconcileBuddyStreaks(now: Date = new Date()): Promise<BuddyReconciliation> {
  const timezone = config().app.timezone;
  // Reconcile yesterday: today is not finished yet.
  const day = dayKey(new Date(now.getTime() - 86_400_000), timezone);

  const pairs = await activeBuddyPairs();
  const result: BuddyReconciliation = { pairs: pairs.length, advanced: 0, broken: 0 };

  for (const pair of pairs) {
    const [aStudied, bStudied] = await Promise.all([
      studiedOn(pair.userA, day),
      studiedOn(pair.userB, day),
    ]);

    const next = resolveBuddyDay(
      { jointStreak: pair.jointStreak, lastBothStudiedDay: pair.lastBothStudiedDay },
      day,
      aStudied && bStudied,
    );

    if (!next.changed) continue;
    if (next.jointStreak === 1 && pair.jointStreak > 1) result.broken += 1;
    else result.advanced += 1;

    await saveBuddyStreak(pair.id, next.jointStreak, day);
  }

  log.info('Buddy streaks reconciled', { day, ...result });
  return result;
}
