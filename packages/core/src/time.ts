/**
 * Local-day arithmetic.
 *
 * Daily goals, streaks and digests all key off the learner's local calendar day,
 * not UTC. v1 hardcoded `Asia/Tehran` via `Intl.DateTimeFormat('en-CA')` in the
 * streak service; the same trick is used here, but the zone is a parameter so a
 * per-user timezone works without touching the callers.
 */

/** `YYYY-MM-DD` in the given IANA zone. `en-CA` yields ISO order natively. */
export function dayKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  return dayKey(a, timeZone) === dayKey(b, timeZone);
}

/** The day key immediately before `instant`'s — used for streak continuity. */
export function previousDayKey(instant: Date, timeZone: string): string {
  return dayKey(new Date(instant.getTime() - 86_400_000), timeZone);
}

/**
 * How much of a daily allowance is left.
 *
 * Clamped at zero: lowering the target below what you have already done should
 * stop the session, never produce a negative quota.
 */
export function remainingToday(target: number, doneToday: number): number {
  return Math.max(0, target - doneToday);
}
