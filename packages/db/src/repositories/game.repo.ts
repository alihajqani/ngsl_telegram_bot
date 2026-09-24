import type { PointReason, StreakState } from '@ngsl/core';
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db, type Database } from '../client.js';
import {
  appUser,
  buddyPair,
  league,
  leagueMembership,
  pointsLedger,
  userSettings,
  userStreak,
} from '../schema.js';

/** Gamification persistence: ledger, streaks, leagues, buddies, lazy board. */

type Row<T> = T & Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Points — append-only
// ─────────────────────────────────────────────────────────────────────────────

export async function awardPoints(
  userId: number,
  delta: number,
  reason: PointReason,
  refId?: number,
  database: Database = db(),
): Promise<void> {
  if (delta === 0) return;
  await database.insert(pointsLedger).values({ userId, delta, reason, refId: refId ?? null });
}

export async function totalPoints(
  userId: number,
  database: Database = db(),
): Promise<number> {
  const [row] = await database
    .select({ total: sql<number>`coalesce(sum(${pointsLedger.delta}), 0)::int` })
    .from(pointsLedger)
    .where(eq(pointsLedger.userId, userId));
  return row?.total ?? 0;
}

export interface LeaderboardRow {
  userId: number;
  firstName: string | null;
  points: number;
  rank: number;
}

/**
 * All-time board, the vanity screen.
 *
 * A window function rather than an aggregation pipeline — this is precisely the
 * query that made a relational store worth the migration.
 */
export async function globalLeaderboard(
  limit = 20,
  database: Database = db(),
): Promise<LeaderboardRow[]> {
  const rows = await database.execute<Row<LeaderboardRow>>(sql`
    select l.user_id as "userId",
           u.first_name as "firstName",
           sum(l.delta)::int as points,
           rank() over (order by sum(l.delta) desc)::int as rank
      from ${pointsLedger} l
      join ${appUser} u on u.id = l.user_id
     where not u.blocked
     group by l.user_id, u.first_name
     order by points desc
     limit ${limit}
  `);
  return [...rows];
}

/** Where a single user sits on the all-time board, however far down. */
export async function globalRank(
  userId: number,
  database: Database = db(),
): Promise<{ points: number; rank: number } | undefined> {
  const [row] = await database.execute<Row<{ points: number; rank: number }>>(sql`
    select points, rank from (
      select l.user_id,
             sum(l.delta)::int as points,
             rank() over (order by sum(l.delta) desc)::int as rank
        from ${pointsLedger} l
        join ${appUser} u on u.id = l.user_id
       where not u.blocked
       group by l.user_id
    ) ranked where user_id = ${userId}
  `);
  return row;
}

/** Every user's all-time rank in one pass, so a bulk send needs no per-user query. */
export async function globalRanks(
  database: Database = db(),
): Promise<Map<number, { points: number; rank: number }>> {
  const rows = await database.execute<Row<{ userId: number; points: number; rank: number }>>(sql`
    select l.user_id as "userId",
           sum(l.delta)::int as points,
           rank() over (order by sum(l.delta) desc)::int as rank
      from ${pointsLedger} l
      join ${appUser} u on u.id = l.user_id
     where not u.blocked
     group by l.user_id
  `);
  return new Map([...rows].map((r) => [r.userId, { points: r.points, rank: r.rank }]));
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaks
// ─────────────────────────────────────────────────────────────────────────────

export async function getStreak(
  userId: number,
  database: Database = db(),
): Promise<StreakState> {
  const [row] = await database
    .select({
      current: userStreak.current,
      longest: userStreak.longest,
      lastStudyDay: userStreak.lastStudyDay,
      freezesAvailable: userStreak.freezesAvailable,
      multiplier: userStreak.multiplier,
    })
    .from(userStreak)
    .where(eq(userStreak.userId, userId));

  return (
    row ?? { current: 0, longest: 0, lastStudyDay: null, freezesAvailable: 0, multiplier: 1 }
  );
}

export async function saveStreak(
  userId: number,
  state: StreakState,
  database: Database = db(),
): Promise<void> {
  await database
    .insert(userStreak)
    .values({ userId, ...state, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userStreak.userId,
      set: {
        current: sql`excluded.current`,
        longest: sql`excluded.longest`,
        lastStudyDay: sql`excluded.last_study_day`,
        freezesAvailable: sql`excluded.freezes_available`,
        multiplier: sql`excluded.multiplier`,
        updatedAt: new Date(),
      },
    });
}

/** Did this user study on a given local day? Drives buddy reconciliation. */
export async function studiedOn(
  userId: number,
  dayKey: string,
  database: Database = db(),
): Promise<boolean> {
  const [row] = await database
    .select({ lastStudyDay: userStreak.lastStudyDay })
    .from(userStreak)
    .where(eq(userStreak.userId, userId));
  return row?.lastStudyDay === dayKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Leagues
// ─────────────────────────────────────────────────────────────────────────────

export async function findOrCreateLeague(
  tier: number,
  weekStart: string,
  database: Database = db(),
): Promise<number> {
  const [existing] = await database
    .select({ id: league.id })
    .from(league)
    .where(and(eq(league.tier, tier), eq(league.weekStart, weekStart)))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await database
    .insert(league)
    .values({ tier, weekStart })
    .returning({ id: league.id });
  return created!.id;
}

export async function joinLeague(
  leagueId: number,
  userId: number,
  database: Database = db(),
): Promise<void> {
  await database
    .insert(leagueMembership)
    .values({ leagueId, userId, points: 0 })
    .onConflictDoNothing();
}

/**
 * Seat a learner in `leagueId` as their only league for `weekStart`.
 *
 * Someone who studies after midnight on Saturday but before the rollover runs is
 * lazily seeded into the bottom tier first. Joining the rollover's league as
 * well would leave them in two cohorts, and every later rollover would carry
 * both forward. Any other membership that week is folded into this one, points
 * included. Re-running is harmless: with nothing to fold, it adds zero.
 */
export async function placeInLeague(
  leagueId: number,
  userId: number,
  weekStart: string,
  database: Database = db(),
): Promise<void> {
  await database.transaction(async (tx) => {
    const strays = await tx
      .select({ leagueId: leagueMembership.leagueId, points: leagueMembership.points })
      .from(leagueMembership)
      .innerJoin(league, eq(league.id, leagueMembership.leagueId))
      .where(
        and(
          eq(leagueMembership.userId, userId),
          eq(league.weekStart, weekStart),
          ne(leagueMembership.leagueId, leagueId),
        ),
      );

    const carried = strays.reduce((sum, s) => sum + s.points, 0);
    if (strays.length > 0) {
      await tx.delete(leagueMembership).where(
        and(
          eq(leagueMembership.userId, userId),
          inArray(
            leagueMembership.leagueId,
            strays.map((s) => s.leagueId),
          ),
        ),
      );
    }

    await tx
      .insert(leagueMembership)
      .values({ leagueId, userId, points: carried })
      .onConflictDoUpdate({
        target: [leagueMembership.leagueId, leagueMembership.userId],
        set: { points: sql`${leagueMembership.points} + ${carried}` },
      });
  });
}

/** Every membership of one week, keyed by user — the nightly boards' lookup. */
export async function weekMemberships(
  weekStart: string,
  database: Database = db(),
): Promise<Map<number, { leagueId: number; tier: number }>> {
  const rows = await database
    .select({ userId: leagueMembership.userId, leagueId: league.id, tier: league.tier })
    .from(leagueMembership)
    .innerJoin(league, eq(league.id, leagueMembership.leagueId))
    .where(eq(league.weekStart, weekStart));
  return new Map(rows.map((r) => [r.userId, { leagueId: r.leagueId, tier: r.tier }]));
}

/** A user's current-week membership, if any. */
export async function currentMembership(
  userId: number,
  weekStart: string,
  database: Database = db(),
): Promise<{ leagueId: number; tier: number; points: number } | undefined> {
  const [row] = await database
    .select({ leagueId: league.id, tier: league.tier, points: leagueMembership.points })
    .from(leagueMembership)
    .innerJoin(league, eq(league.id, leagueMembership.leagueId))
    .where(and(eq(leagueMembership.userId, userId), eq(league.weekStart, weekStart)))
    .limit(1);
  return row;
}

/** Mirror an award into the current league standing. */
export async function addLeaguePoints(
  leagueId: number,
  userId: number,
  delta: number,
  database: Database = db(),
): Promise<void> {
  await database
    .update(leagueMembership)
    .set({ points: sql`${leagueMembership.points} + ${delta}` })
    .where(
      and(eq(leagueMembership.leagueId, leagueId), eq(leagueMembership.userId, userId)),
    );
}

export async function leagueStandings(
  leagueId: number,
  database: Database = db(),
): Promise<LeaderboardRow[]> {
  const rows = await database.execute<Row<LeaderboardRow>>(sql`
    select m.user_id as "userId",
           u.first_name as "firstName",
           m.points,
           rank() over (order by m.points desc, m.user_id)::int as rank
      from ${leagueMembership} m
      join ${appUser} u on u.id = m.user_id
     where m.league_id = ${leagueId}
     order by rank
  `);
  return [...rows];
}

export async function leaguesForWeek(
  weekStart: string,
  database: Database = db(),
): Promise<{ id: number; tier: number }[]> {
  return database
    .select({ id: league.id, tier: league.tier })
    .from(league)
    .where(eq(league.weekStart, weekStart));
}

// ─────────────────────────────────────────────────────────────────────────────
// Buddies
// ─────────────────────────────────────────────────────────────────────────────

export interface BuddyRecord {
  id: number;
  userA: number;
  userB: number;
  jointStreak: number;
  lastBothStudiedDay: string | null;
  status: 'pending' | 'active' | 'ended';
}

export async function findBuddy(
  userId: number,
  database: Database = db(),
): Promise<BuddyRecord | undefined> {
  const [row] = await database
    .select({
      id: buddyPair.id,
      userA: buddyPair.userA,
      userB: buddyPair.userB,
      jointStreak: buddyPair.jointStreak,
      lastBothStudiedDay: buddyPair.lastBothStudiedDay,
      status: buddyPair.status,
    })
    .from(buddyPair)
    .where(
      and(
        or(eq(buddyPair.userA, userId), eq(buddyPair.userB, userId)),
        eq(buddyPair.status, 'active'),
      ),
    )
    .limit(1);
  return row;
}

export async function createBuddyPair(
  userA: number,
  userB: number,
  database: Database = db(),
): Promise<number | undefined> {
  if (userA === userB) return undefined;
  const [row] = await database
    .insert(buddyPair)
    .values({ userA, userB, status: 'active' })
    .returning({ id: buddyPair.id });
  return row?.id;
}

export async function saveBuddyStreak(
  pairId: number,
  jointStreak: number,
  lastBothStudiedDay: string,
  database: Database = db(),
): Promise<void> {
  await database
    .update(buddyPair)
    .set({ jointStreak, lastBothStudiedDay })
    .where(eq(buddyPair.id, pairId));
}

export async function activeBuddyPairs(
  database: Database = db(),
): Promise<BuddyRecord[]> {
  return database
    .select({
      id: buddyPair.id,
      userA: buddyPair.userA,
      userB: buddyPair.userB,
      jointStreak: buddyPair.jointStreak,
      lastBothStudiedDay: buddyPair.lastBothStudiedDay,
      status: buddyPair.status,
    })
    .from(buddyPair)
    .where(eq(buddyPair.status, 'active'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Wall of Shame — opt-in only
// ─────────────────────────────────────────────────────────────────────────────

export interface LazyRow {
  userId: number;
  firstName: string | null;
  lastStudyDay: string | null;
  daysMissed: number;
}

/**
 * The Lazy Board.
 *
 * `wall_of_shame_optin` is required, and it is the whole ethics of the feature:
 * an involuntary public shame list loses users and invites moderation problems.
 * Appearing is opt-in, and leaving is one session away.
 */
export async function lazyBoard(
  today: string,
  thresholdDays: number,
  limit = 20,
  database: Database = db(),
): Promise<LazyRow[]> {
  const rows = await database.execute<Row<LazyRow>>(sql`
    select s.user_id as "userId",
           u.first_name as "firstName",
           s.last_study_day as "lastStudyDay",
           (${today}::date - s.last_study_day)::int as "daysMissed"
      from ${userStreak} s
      join ${appUser} u on u.id = s.user_id
      join ${userSettings} st on st.user_id = s.user_id
     where st.wall_of_shame_optin
       and not u.blocked
       and s.last_study_day is not null
       and (${today}::date - s.last_study_day) >= ${thresholdDays}
     order by "daysMissed" desc
     limit ${limit}
  `);
  return [...rows];
}

export async function setWallOfShameOptin(
  userId: number,
  optIn: boolean,
  database: Database = db(),
): Promise<void> {
  await database
    .insert(userSettings)
    .values({ userId, wallOfShameOptin: optIn })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { wallOfShameOptin: optIn, updatedAt: new Date() },
    });
}
