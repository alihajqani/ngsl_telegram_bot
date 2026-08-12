/**
 * Weekly leagues.
 *
 * A single global leaderboard demotivates the ~90% who will never approach the
 * top — "rank 4,120 of 5,000" is a reason to quit. Cohorts of ~30 with
 * promotion and relegation keep every learner near a boundary that matters, so
 * the board stays motivating at every skill level.
 */

export const COHORT_SIZE = 30;
export const PROMOTE_COUNT = 5;
export const DEMOTE_COUNT = 5;

export const TIERS = ['bronze', 'silver', 'gold', 'sapphire', 'diamond'] as const;
export type Tier = (typeof TIERS)[number];

export const MIN_TIER = 1;
export const MAX_TIER = TIERS.length;

export function tierName(tier: number): Tier {
  return TIERS[Math.min(TIERS.length, Math.max(1, tier)) - 1]!;
}

export interface Standing {
  userId: number;
  points: number;
}

export interface LeagueOutcome {
  promote: number[];
  demote: number[];
  hold: number[];
}

/**
 * Split users into cohorts.
 *
 * The tail is merged into the previous cohort rather than left as a lonely
 * group of two, which would make promotion meaningless for those users.
 */
export function assignCohorts(userIds: readonly number[], size = COHORT_SIZE): number[][] {
  if (userIds.length === 0) return [];
  if (userIds.length <= size) return [[...userIds]];

  const cohorts: number[][] = [];
  for (let i = 0; i < userIds.length; i += size) {
    cohorts.push(userIds.slice(i, i + size));
  }

  const last = cohorts[cohorts.length - 1]!;
  if (last.length < Math.ceil(size / 2) && cohorts.length > 1) {
    cohorts[cohorts.length - 2]!.push(...last);
    cohorts.pop();
  }
  return cohorts;
}

/**
 * Resolve one week of a cohort.
 *
 * Three guards matter. Users at the top tier cannot promote and users at the
 * bottom cannot demote. A learner who scored nothing is never promoted, however
 * empty the cohort. And in a small cohort the promote and demote bands are
 * shrunk so they cannot overlap — otherwise the same user could appear in both.
 */
export function resolveLeague(
  standings: readonly Standing[],
  tier: number,
  options: { promote?: number; demote?: number } = {},
): LeagueOutcome {
  const ranked = [...standings].sort((a, b) => b.points - a.points || a.userId - b.userId);

  let promote = options.promote ?? PROMOTE_COUNT;
  let demote = options.demote ?? DEMOTE_COUNT;

  if (promote + demote > ranked.length) {
    const half = Math.floor(ranked.length / 2);
    promote = Math.min(promote, half);
    demote = Math.min(demote, half);
  }

  if (tier >= MAX_TIER) promote = 0;
  if (tier <= MIN_TIER) demote = 0;

  const promoted = ranked.slice(0, promote).filter((s) => s.points > 0);
  const demoted = demote > 0 ? ranked.slice(ranked.length - demote) : [];

  const promotedIds = new Set(promoted.map((s) => s.userId));
  const demotedIds = new Set(demoted.map((s) => s.userId));

  return {
    promote: [...promotedIds],
    demote: [...demotedIds],
    hold: ranked
      .filter((s) => !promotedIds.has(s.userId) && !demotedIds.has(s.userId))
      .map((s) => s.userId),
  };
}

export function nextTier(tier: number, direction: 'promote' | 'demote'): number {
  return direction === 'promote'
    ? Math.min(MAX_TIER, tier + 1)
    : Math.max(MIN_TIER, tier - 1);
}

/** The Monday of the week containing `dayKey`, as a 'YYYY-MM-DD' key. */
export function weekStartKey(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00Z`);
  // getUTCDay: 0 = Sunday, so Monday-based offset needs the wrap.
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}
