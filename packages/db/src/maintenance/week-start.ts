import { weekStartKey } from '@ngsl/core';
import { eq } from 'drizzle-orm';
import type { Database } from '../client.js';
import { placeInLeague } from '../repositories/game.repo.js';
import { league, leagueMembership } from '../schema.js';

/**
 * One-off switch of stored leagues from Monday weeks to Saturday weeks.
 *
 * `weekStartKey` now returns Saturdays, so a league still keyed by its Monday is
 * invisible to the code: members of the running week would be re-seeded into
 * the bottom tier on their next activity, and the rollover would never close it.
 */

function shiftDays(dayKey: string, days: number): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isMondayKey(dayKey: string): boolean {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay() === 1;
}

/** The Monday that opened the old-style week containing `dayKey`. */
function mondayOf(dayKey: string): string {
  return shiftDays(dayKey, -((new Date(`${dayKey}T00:00:00Z`).getUTCDay() + 6) % 7));
}

/**
 * The Saturday week a Monday-keyed league belongs to.
 *
 * A finished week takes the Saturday before its Monday. The running week must
 * land on the week that contains today, or the league stays invisible. That is
 * the same Saturday from Monday to Friday, but on Saturday and Sunday the new
 * week has already begun, so the running league moves forward into it and lasts
 * until the next rollover.
 */
export function saturdayWeekFor(mondayKey: string, todayKey: string): string {
  return mondayKey === mondayOf(todayKey) ? weekStartKey(todayKey) : shiftDays(mondayKey, -2);
}

export interface WeekStartMigration {
  leaguesMoved: number;
  membersSettled: number;
  currentWeek: string;
}

/**
 * Rewrite every Monday-keyed league to its Saturday week.
 *
 * Idempotent: a second run finds no Mondays. Members of the current week are
 * then re-seated with `placeInLeague`, which folds any bottom-tier membership
 * they were lazily given after the new code went live into their real league.
 */
export async function migrateLeaguesToSaturday(
  database: Database,
  todayKey: string,
): Promise<WeekStartMigration> {
  const currentWeek = weekStartKey(todayKey);
  const leagues = await database
    .select({ id: league.id, weekStart: league.weekStart })
    .from(league);

  const result: WeekStartMigration = { leaguesMoved: 0, membersSettled: 0, currentWeek };
  const current: number[] = [];

  for (const row of leagues) {
    if (!isMondayKey(row.weekStart)) continue;
    const target = saturdayWeekFor(row.weekStart, todayKey);
    await database.update(league).set({ weekStart: target }).where(eq(league.id, row.id));
    result.leaguesMoved += 1;
    if (target === currentWeek) current.push(row.id);
  }

  for (const leagueId of current) {
    const members = await database
      .select({ userId: leagueMembership.userId })
      .from(leagueMembership)
      .where(eq(leagueMembership.leagueId, leagueId));
    for (const { userId } of members) {
      await placeInLeague(leagueId, userId, currentWeek, database);
      result.membersSettled += 1;
    }
  }

  return result;
}
