/**
 * Streak mechanics.
 *
 * A plain consecutive-day counter has one fatal flaw: the day it breaks, the
 * learner's entire investment zeroes and they churn. Three mechanics attack
 * that, and all three live here as pure functions.
 *
 *  1. **Freezes** absorb a missed day, so a slip does not erase months.
 *  2. **A compounding multiplier** turns the streak from a vanity number into
 *     an asset with ongoing yield — breaking it costs future points, which is a
 *     far stronger motivator than losing a counter.
 *  3. **Buddy streaks** (see `resolveBuddyDay`) only advance when both partners
 *     studied, which is both the strongest retention lever and a viral loop.
 *
 * Misses are evaluated lazily, on the learner's next activity, rather than by a
 * nightly sweep. That keeps the rule in one place and means a worker outage can
 * never silently break someone's streak.
 */

export interface StreakState {
  current: number;
  longest: number;
  /** 'YYYY-MM-DD' in the learner's timezone, or null if they have never studied. */
  lastStudyDay: string | null;
  freezesAvailable: number;
  multiplier: number;
}

export interface StreakTransition extends StreakState {
  /** False when the learner already studied today — the call is idempotent. */
  changed: boolean;
  /** True on the first day of a fresh streak. */
  started: boolean;
  /** How many banked freezes this activity consumed. */
  freezesUsed: number;
  /** True when the streak reset despite (or without) freezes. */
  broken: boolean;
  /** Set when this activity crossed a milestone worth celebrating. */
  milestone: number | null;
}

/** Earn one freeze per full week, banked up to this cap. */
export const FREEZE_EARN_EVERY = 7;
export const MAX_FREEZES = 2;

export const MILESTONES = [3, 7, 14, 30, 60, 100, 365] as const;

/** Day 1–6 ×1.0, day 7–29 ×1.5, day 30+ ×2.0. */
export function multiplierFor(streak: number): number {
  if (streak >= 30) return 2;
  if (streak >= 7) return 1.5;
  return 1;
}

const DAY_MS = 86_400_000;

/** Whole days between two 'YYYY-MM-DD' keys. Parsed as UTC so DST cannot skew it. */
export function daysBetweenKeys(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / DAY_MS);
}

export type StreakStatus = 'none' | 'active' | 'atRisk' | 'broken';

/**
 * Display status, for reminders and the progress screen.
 * `atRisk` means they studied yesterday but not yet today — the nudge window.
 */
export function streakStatus(state: StreakState, today: string): StreakStatus {
  if (state.lastStudyDay === null || state.current === 0) return 'none';
  const gap = daysBetweenKeys(state.lastStudyDay, today);
  if (gap === 0) return 'active';
  if (gap === 1) return 'atRisk';
  return 'broken';
}

function milestoneFor(streak: number): number | null {
  return MILESTONES.includes(streak as (typeof MILESTONES)[number]) ? streak : null;
}

/**
 * Register a day of study.
 *
 * Idempotent within a day: the first qualifying activity advances the streak
 * and every later one is a no-op, so learning and reviewing on the same day
 * cannot double-count.
 */
export function recordStudyDay(state: StreakState, today: string): StreakTransition {
  const unchanged = (): StreakTransition => ({
    ...state,
    changed: false,
    started: false,
    freezesUsed: 0,
    broken: false,
    milestone: null,
  });

  if (state.lastStudyDay === today) return unchanged();

  const gap = state.lastStudyDay === null ? Infinity : daysBetweenKeys(state.lastStudyDay, today);

  // A clock skew or a corrected timezone could place "today" before the last
  // recorded day; treat that as already handled rather than rewinding.
  if (gap <= 0) return unchanged();

  let current: number;
  let freezesUsed = 0;
  let broken = false;
  let started = false;

  if (gap === 1) {
    current = state.current + 1;
  } else {
    // gap - 1 days were missed; freezes can cover them one for one.
    const missed = gap === Infinity ? Infinity : gap - 1;
    if (missed !== Infinity && missed <= state.freezesAvailable) {
      freezesUsed = missed;
      current = state.current + 1;
    } else {
      current = 1;
      broken = state.current > 0;
      started = true;
    }
  }

  // Freezes are earned on completed weeks of the *new* streak length.
  const earned =
    Math.floor(current / FREEZE_EARN_EVERY) - Math.floor(Math.max(0, current - 1) / FREEZE_EARN_EVERY);

  const freezesAvailable = Math.min(
    MAX_FREEZES,
    Math.max(0, state.freezesAvailable - freezesUsed + earned),
  );

  return {
    current,
    longest: Math.max(state.longest, current),
    lastStudyDay: today,
    freezesAvailable,
    multiplier: multiplierFor(current),
    changed: true,
    started,
    freezesUsed,
    broken,
    milestone: milestoneFor(current),
  };
}

export interface BuddyState {
  jointStreak: number;
  lastBothStudiedDay: string | null;
}

/**
 * Advance a buddy streak, which only moves when BOTH partners studied.
 *
 * That is the point: the obligation is social, so the pair carries each other
 * on the days motivation fails. No freezes here — the partner is the safety net.
 */
export function resolveBuddyDay(
  state: BuddyState,
  today: string,
  bothStudied: boolean,
): BuddyState & { changed: boolean } {
  if (!bothStudied || state.lastBothStudiedDay === today) {
    return { ...state, changed: false };
  }

  const gap =
    state.lastBothStudiedDay === null
      ? Infinity
      : daysBetweenKeys(state.lastBothStudiedDay, today);

  return {
    jointStreak: gap === 1 ? state.jointStreak + 1 : 1,
    lastBothStudiedDay: today,
    changed: true,
  };
}

/** Days since the learner last studied — the Lazy Board's input. */
export function daysInactive(lastStudyDay: string | null, today: string): number {
  return lastStudyDay === null ? Infinity : daysBetweenKeys(lastStudyDay, today);
}

/** Opt-in Lazy Board threshold: three consecutive missed days. */
export const LAZY_THRESHOLD_DAYS = 3;

export function isLazy(lastStudyDay: string | null, today: string): boolean {
  return daysInactive(lastStudyDay, today) >= LAZY_THRESHOLD_DAYS;
}
