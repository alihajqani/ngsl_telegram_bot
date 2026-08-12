import { describe, expect, it } from 'vitest';
import {
  applyReview,
  BOX_INTERVAL_DAYS,
  initialState,
  isDue,
  nextBox,
  nextReviewAt,
  type Box,
  type LeitnerState,
} from './leitner.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const DAY_MS = 86_400_000;

const stateAt = (box: Box): LeitnerState => ({
  box,
  reviewCount: 3,
  nextReviewAt: NOW,
  lastReviewedAt: NOW,
});

describe('nextBox', () => {
  it('advances one box on a correct answer', () => {
    expect(nextBox(1, 'correct')).toBe(2);
    expect(nextBox(4, 'correct')).toBe(5);
  });

  it('clamps at box 5 instead of overflowing', () => {
    expect(nextBox(5, 'correct')).toBe(5);
  });

  it('resets to box 1 on a wrong answer, from any box', () => {
    for (const box of [1, 2, 3, 4, 5] as Box[]) {
      expect(nextBox(box, 'wrong')).toBe(1);
    }
  });

  it('jumps straight to box 5 for "I know this"', () => {
    expect(nextBox(1, 'known')).toBe(5);
    expect(nextBox(3, 'known')).toBe(5);
  });
});

describe('nextReviewAt', () => {
  it('schedules using the interval of the box passed in', () => {
    for (const box of [1, 2, 3, 4, 5] as Box[]) {
      const due = nextReviewAt(box, NOW);
      expect(due.getTime() - NOW.getTime()).toBe(BOX_INTERVAL_DAYS[box] * DAY_MS);
    }
  });
});

describe('applyReview', () => {
  it('schedules from the NEW box, not the old one', () => {
    // Box 2 + correct → box 3, so the next interval must be 4 days, not 2.
    const result = applyReview(stateAt(2), 'correct', NOW);
    expect(result.box).toBe(3);
    expect(result.nextReviewAt.getTime() - NOW.getTime()).toBe(4 * DAY_MS);
  });

  it('reschedules a wrong answer at the box-1 interval', () => {
    const result = applyReview(stateAt(5), 'wrong', NOW);
    expect(result.box).toBe(1);
    expect(result.nextReviewAt.getTime() - NOW.getTime()).toBe(1 * DAY_MS);
  });

  it('counts "I know this" as a review and defers 16 days', () => {
    const result = applyReview(stateAt(1), 'known', NOW);
    expect(result.box).toBe(5);
    expect(result.reviewCount).toBe(4);
    expect(result.nextReviewAt.getTime() - NOW.getTime()).toBe(16 * DAY_MS);
  });

  it('always increments the review count and stamps lastReviewedAt', () => {
    for (const outcome of ['correct', 'wrong', 'known'] as const) {
      const result = applyReview(stateAt(2), outcome, NOW);
      expect(result.reviewCount).toBe(4);
      expect(result.lastReviewedAt).toEqual(NOW);
    }
  });
});

describe('initialState', () => {
  it('starts a new word in box 1, due tomorrow, never reviewed', () => {
    const state = initialState(NOW);
    expect(state.box).toBe(1);
    expect(state.reviewCount).toBe(0);
    expect(state.lastReviewedAt).toBeNull();
    expect(state.nextReviewAt.getTime() - NOW.getTime()).toBe(DAY_MS);
  });
});

describe('isDue', () => {
  it('treats a word as due exactly at its scheduled instant', () => {
    expect(isDue(stateAt(1), NOW)).toBe(true);
  });

  it('is not due one millisecond early', () => {
    const state = { ...stateAt(1), nextReviewAt: new Date(NOW.getTime() + 1) };
    expect(isDue(state, NOW)).toBe(false);
  });
});
