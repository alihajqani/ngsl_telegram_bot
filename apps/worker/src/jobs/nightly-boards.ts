import { dayKey, daysLeftInWeek, LAZY_THRESHOLD_DAYS, weekStartKey } from '@ngsl/core';
import {
  dailyDispatchAudience,
  globalLeaderboard,
  globalRanks,
  lazyBoard,
  leagueStandings,
  weekMemberships,
  type LeaderboardRow,
} from '@ngsl/db';
import { config, createLogger } from '@ngsl/shared';
import { BOARD_SIZE, renderNightlyBoards } from './boards-message.js';
import { deliver, pace, type DispatchResult } from './dispatch.js';

const log = createLogger('worker.nightly-boards');

/**
 * Nightly boards at 22:00: each learner's league, the all-time board and the
 * Lazy Board, sent to everyone who has not switched it off in settings.
 *
 * The boards are the same for everybody, so they are read once per run; league
 * standings are read once per league. Per-user work is only rendering.
 */
export async function runNightlyBoards(now: Date = new Date()): Promise<DispatchResult> {
  const today = dayKey(now, config().app.timezone);
  const [audience, top, ranks, memberships, lazy] = await Promise.all([
    dailyDispatchAudience('digest'),
    globalLeaderboard(BOARD_SIZE),
    globalRanks(),
    weekMemberships(weekStartKey(today)),
    lazyBoard(today, LAZY_THRESHOLD_DAYS, BOARD_SIZE),
  ]);

  // Before anyone has earned a point there is no board worth a notification.
  if (top.length === 0) {
    log.info('Nightly boards skipped: no points yet', { audience: audience.length });
    return { audience: audience.length, sent: 0 };
  }

  const standings = new Map<number, LeaderboardRow[]>();
  const daysLeft = daysLeftInWeek(today);
  let sent = 0;

  for (const target of audience) {
    const membership = memberships.get(target.userId);
    let league: { tier: number; standings: LeaderboardRow[] } | undefined;
    if (membership) {
      let rows = standings.get(membership.leagueId);
      if (!rows) {
        rows = await leagueStandings(membership.leagueId);
        standings.set(membership.leagueId, rows);
      }
      league = { tier: membership.tier, standings: rows };
    }

    const text = renderNightlyBoards({
      locale: target.locale,
      userId: target.userId,
      daysLeft,
      league,
      global: { top, you: ranks.get(target.userId) },
      lazy,
    });

    if (await deliver(target, text)) sent += 1;
    await pace();
  }

  log.info('Nightly boards dispatched', { audience: audience.length, sent, leagues: standings.size });
  return { audience: audience.length, sent };
}
