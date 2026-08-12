import { describe, expect, it } from 'vitest';
import {
  daysBetweenKeys,
  isLazy,
  MAX_FREEZES,
  multiplierFor,
  recordStudyDay,
  resolveBuddyDay,
  streakStatus,
  type StreakState,
} from './streak.js';

const base = (overrides: Partial<StreakState> = {}): StreakState => ({
  current: 0,
  longest: 0,
  lastStudyDay: null,
  freezesAvailable: 0,
  multiplier: 1,
  ...overrides,
});

describe('daysBetweenKeys', () => {
  it('counts whole days', () => {
    expect(daysBetweenKeys('2026-08-10', '2026-08-11')).toBe(1);
    expect(daysBetweenKeys('2026-08-10', '2026-08-10')).toBe(0);
  });

  it('crosses month and year boundaries', () => {
    expect(daysBetweenKeys('2026-08-31', '2026-09-01')).toBe(1);
    expect(daysBetweenKeys('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('is unaffected by daylight-saving transitions', () => {
    // Parsed as UTC precisely so a 23- or 25-hour local day still counts as one.
    expect(daysBetweenKeys('2026-03-28', '2026-03-29')).toBe(1);
    expect(daysBetweenKeys('2026-10-24', '2026-10-25')).toBe(1);
  });
});

describe('multiplierFor', () => {
  it('compounds at day 7 and day 30', () => {
    expect(multiplierFor(1)).toBe(1);
    expect(multiplierFor(6)).toBe(1);
    expect(multiplierFor(7)).toBe(1.5);
    expect(multiplierFor(29)).toBe(1.5);
    expect(multiplierFor(30)).toBe(2);
    expect(multiplierFor(365)).toBe(2);
  });
});

describe('recordStudyDay', () => {
  it('starts a streak for a first-time learner', () => {
    const result = recordStudyDay(base(), '2026-08-10');
    expect(result.current).toBe(1);
    expect(result.started).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.broken).toBe(false);
  });

  it('is idempotent within the same day', () => {
    // Learning and reviewing on one day must not double-count.
    const state = base({ current: 4, lastStudyDay: '2026-08-10' });
    const result = recordStudyDay(state, '2026-08-10');
    expect(result.changed).toBe(false);
    expect(result.current).toBe(4);
  });

  it('advances on a consecutive day', () => {
    const result = recordStudyDay(base({ current: 4, lastStudyDay: '2026-08-09' }), '2026-08-10');
    expect(result.current).toBe(5);
    expect(result.broken).toBe(false);
  });

  it('tracks the longest streak ever reached', () => {
    const result = recordStudyDay(
      base({ current: 9, longest: 12, lastStudyDay: '2026-08-09' }),
      '2026-08-10',
    );
    expect(result.longest).toBe(12);
    expect(recordStudyDay(base({ current: 12, longest: 12, lastStudyDay: '2026-08-09' }), '2026-08-10').longest).toBe(13);
  });

  describe('freezes', () => {
    it('consumes a freeze to survive one missed day', () => {
      const state = base({ current: 10, lastStudyDay: '2026-08-08', freezesAvailable: 1 });
      const result = recordStudyDay(state, '2026-08-10'); // missed the 9th

      expect(result.current).toBe(11);
      expect(result.freezesUsed).toBe(1);
      expect(result.freezesAvailable).toBe(0);
      expect(result.broken).toBe(false);
    });

    it('consumes two freezes for two missed days', () => {
      const state = base({ current: 10, lastStudyDay: '2026-08-07', freezesAvailable: 2 });
      const result = recordStudyDay(state, '2026-08-10');
      expect(result.current).toBe(11);
      expect(result.freezesUsed).toBe(2);
    });

    it('breaks when the gap exceeds the banked freezes', () => {
      const state = base({ current: 10, lastStudyDay: '2026-08-07', freezesAvailable: 1 });
      const result = recordStudyDay(state, '2026-08-10'); // 2 missed, 1 freeze

      expect(result.current).toBe(1);
      expect(result.broken).toBe(true);
      expect(result.freezesUsed).toBe(0);
      // Freezes are not spent on a streak that broke anyway.
      expect(result.freezesAvailable).toBe(1);
    });

    it('earns a freeze on every completed week', () => {
      const day6 = recordStudyDay(base({ current: 6, lastStudyDay: '2026-08-09' }), '2026-08-10');
      expect(day6.current).toBe(7);
      expect(day6.freezesAvailable).toBe(1);

      const day13 = recordStudyDay(
        base({ current: 13, lastStudyDay: '2026-08-09', freezesAvailable: 1 }),
        '2026-08-10',
      );
      expect(day13.freezesAvailable).toBe(2);
    });

    it('never banks more than the cap', () => {
      const result = recordStudyDay(
        base({ current: 20, lastStudyDay: '2026-08-09', freezesAvailable: MAX_FREEZES }),
        '2026-08-10',
      );
      expect(result.freezesAvailable).toBeLessThanOrEqual(MAX_FREEZES);
    });

    it('resets the multiplier when a long streak finally breaks', () => {
      const result = recordStudyDay(
        base({ current: 40, multiplier: 2, lastStudyDay: '2026-07-01' }),
        '2026-08-10',
      );
      expect(result.current).toBe(1);
      expect(result.multiplier).toBe(1);
    });
  });

  it('flags milestones worth celebrating', () => {
    expect(recordStudyDay(base({ current: 6, lastStudyDay: '2026-08-09' }), '2026-08-10').milestone).toBe(7);
    expect(recordStudyDay(base({ current: 7, lastStudyDay: '2026-08-09' }), '2026-08-10').milestone).toBeNull();
  });

  it('ignores a day earlier than the last recorded one', () => {
    // Clock skew or a corrected timezone must not rewind a streak.
    const result = recordStudyDay(base({ current: 5, lastStudyDay: '2026-08-10' }), '2026-08-09');
    expect(result.changed).toBe(false);
    expect(result.current).toBe(5);
  });
});

describe('streakStatus', () => {
  it('reports none, active, atRisk and broken', () => {
    expect(streakStatus(base(), '2026-08-10')).toBe('none');
    expect(streakStatus(base({ current: 3, lastStudyDay: '2026-08-10' }), '2026-08-10')).toBe('active');
    expect(streakStatus(base({ current: 3, lastStudyDay: '2026-08-09' }), '2026-08-10')).toBe('atRisk');
    expect(streakStatus(base({ current: 3, lastStudyDay: '2026-08-05' }), '2026-08-10')).toBe('broken');
  });
});

describe('resolveBuddyDay', () => {
  const buddy = (jointStreak: number, last: string | null) => ({ jointStreak, lastBothStudiedDay: last });

  it('does not advance unless both partners studied', () => {
    const result = resolveBuddyDay(buddy(4, '2026-08-09'), '2026-08-10', false);
    expect(result.changed).toBe(false);
    expect(result.jointStreak).toBe(4);
  });

  it('advances when both studied on a consecutive day', () => {
    const result = resolveBuddyDay(buddy(4, '2026-08-09'), '2026-08-10', true);
    expect(result.jointStreak).toBe(5);
    expect(result.changed).toBe(true);
  });

  it('resets after a gap, with no freeze to soften it', () => {
    // The partner is the safety net; there is no second one.
    expect(resolveBuddyDay(buddy(9, '2026-08-01'), '2026-08-10', true).jointStreak).toBe(1);
  });

  it('is idempotent within a day', () => {
    expect(resolveBuddyDay(buddy(4, '2026-08-10'), '2026-08-10', true).changed).toBe(false);
  });

  it('starts at 1 for a new pair', () => {
    expect(resolveBuddyDay(buddy(0, null), '2026-08-10', true).jointStreak).toBe(1);
  });
});

describe('isLazy', () => {
  it('is true only after three missed days', () => {
    expect(isLazy('2026-08-09', '2026-08-10')).toBe(false);
    expect(isLazy('2026-08-08', '2026-08-10')).toBe(false);
    expect(isLazy('2026-08-07', '2026-08-10')).toBe(true);
  });

  it('treats a learner who has never studied as lazy', () => {
    expect(isLazy(null, '2026-08-10')).toBe(true);
  });
});
