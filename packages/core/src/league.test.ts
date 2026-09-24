import { describe, expect, it } from 'vitest';
import {
  assignCohorts,
  daysLeftInWeek,
  MAX_TIER,
  nextTier,
  resolveLeague,
  tierName,
  weekStartKey,
  type Standing,
} from './league.js';
import { pointsFor, POINT_VALUES } from './points.js';

const standings = (points: number[]): Standing[] =>
  points.map((p, i) => ({ userId: i + 1, points: p }));

describe('assignCohorts', () => {
  it('keeps a small population in one cohort', () => {
    expect(assignCohorts([1, 2, 3], 30)).toEqual([[1, 2, 3]]);
  });

  it('splits into cohorts of the requested size', () => {
    const cohorts = assignCohorts(Array.from({ length: 60 }, (_, i) => i + 1), 30);
    expect(cohorts).toHaveLength(2);
    expect(cohorts[0]).toHaveLength(30);
  });

  it('merges a small tail rather than stranding it', () => {
    // A trailing cohort of 2 would make promotion meaningless for those users.
    const cohorts = assignCohorts(Array.from({ length: 32 }, (_, i) => i + 1), 30);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]).toHaveLength(32);
  });

  it('handles an empty population', () => {
    expect(assignCohorts([], 30)).toEqual([]);
  });

  it('loses nobody', () => {
    const ids = Array.from({ length: 137 }, (_, i) => i + 1);
    expect(assignCohorts(ids, 30).flat().sort((a, b) => a - b)).toEqual(ids);
  });
});

describe('resolveLeague', () => {
  it('promotes the top five and demotes the bottom five', () => {
    const result = resolveLeague(standings([100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 5, 1]), 2);
    expect(result.promote).toEqual([1, 2, 3, 4, 5]);
    expect(result.demote).toEqual([8, 9, 10, 11, 12]);
  });

  it('never promotes and demotes the same user', () => {
    const result = resolveLeague(standings([10, 8, 6, 4]), 2);
    const overlap = result.promote.filter((id) => result.demote.includes(id));
    expect(overlap).toEqual([]);
  });

  it('accounts for every user exactly once', () => {
    const result = resolveLeague(standings([9, 8, 7, 6, 5, 4, 3, 2, 1]), 2);
    const all = [...result.promote, ...result.demote, ...result.hold].sort((a, b) => a - b);
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('does not promote out of the top tier', () => {
    expect(resolveLeague(standings([100, 90, 80]), MAX_TIER).promote).toEqual([]);
  });

  it('does not demote out of the bottom tier', () => {
    expect(resolveLeague(standings([30, 20, 10]), 1).demote).toEqual([]);
  });

  it('refuses to promote a user who scored nothing', () => {
    // An empty cohort must not hand out promotions for inactivity.
    const result = resolveLeague(standings([0, 0, 0, 0, 0, 0, 0, 0]), 2);
    expect(result.promote).toEqual([]);
  });

  it('breaks ties deterministically', () => {
    const a = resolveLeague(standings([10, 10, 10, 10, 10, 10]), 2);
    const b = resolveLeague(standings([10, 10, 10, 10, 10, 10]), 2);
    expect(a.promote).toEqual(b.promote);
  });

  it('handles a cohort of one', () => {
    const result = resolveLeague(standings([50]), 2);
    expect(result.promote.length + result.demote.length).toBeLessThanOrEqual(1);
  });
});

describe('nextTier', () => {
  it('clamps at both ends', () => {
    expect(nextTier(1, 'demote')).toBe(1);
    expect(nextTier(MAX_TIER, 'promote')).toBe(MAX_TIER);
    expect(nextTier(2, 'promote')).toBe(3);
  });
});

describe('tierName', () => {
  it('names each tier and clamps out-of-range input', () => {
    expect(tierName(1)).toBe('bronze');
    expect(tierName(MAX_TIER)).toBe('diamond');
    expect(tierName(99)).toBe('diamond');
    expect(tierName(0)).toBe('bronze');
  });
});

describe('weekStartKey', () => {
  it('returns the Saturday of that week', () => {
    // 2026-08-08 is a Saturday.
    expect(weekStartKey('2026-08-08')).toBe('2026-08-08');
    expect(weekStartKey('2026-08-10')).toBe('2026-08-08'); // Monday is mid-week
    expect(weekStartKey('2026-08-14')).toBe('2026-08-08'); // Friday closes the week
    expect(weekStartKey('2026-08-15')).toBe('2026-08-15');
  });

  it('crosses month and year boundaries', () => {
    // 2027-01-01 is a Friday, so its week began in December.
    expect(weekStartKey('2027-01-01')).toBe('2026-12-26');
  });
});

describe('daysLeftInWeek', () => {
  it('counts today, so Saturday has the whole week and Friday is the last day', () => {
    expect(daysLeftInWeek('2026-08-08')).toBe(7);
    expect(daysLeftInWeek('2026-08-10')).toBe(5);
    expect(daysLeftInWeek('2026-08-14')).toBe(1);
  });
});

describe('pointsFor', () => {
  it('applies the streak multiplier', () => {
    expect(pointsFor('new_word', 1)).toBe(POINT_VALUES.new_word);
    expect(pointsFor('new_word', 2)).toBe(POINT_VALUES.new_word * 2);
    expect(pointsFor('review_correct', 1.5)).toBe(Math.round(POINT_VALUES.review_correct * 1.5));
  });

  it('does not multiply the streak milestone bonus', () => {
    // It already rewards the streak; multiplying would compound the same thing.
    expect(pointsFor('streak_milestone', 2)).toBe(POINT_VALUES.streak_milestone);
  });

  it('weights writing far above a clip tap', () => {
    expect(pointsFor('writing_submitted')).toBeGreaterThan(pointsFor('clip_watched') * 10);
  });
});
