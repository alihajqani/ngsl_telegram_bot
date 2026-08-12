import { describe, expect, it } from 'vitest';
import {
  BOX_WEIGHT,
  progressBar,
  retention,
  strength,
  summarizeProgress,
  type ProgressInput,
} from './progress.js';
import type { Box } from './leitner.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const wordAt = (box: Box, reviewedDaysAgo: number): ProgressInput => ({
  box,
  lastReviewedAt: daysAgo(reviewedDaysAgo),
  firstSeenAt: daysAgo(reviewedDaysAgo + 10),
});

describe('retention', () => {
  it('is 1.0 immediately after a review', () => {
    expect(retention(3, 0)).toBe(1);
  });

  it('is exactly 0.5 at the moment the word falls due', () => {
    // Half-life is the box interval, so retention hits 0.5 precisely at due time.
    expect(retention(1, 1)).toBeCloseTo(0.5, 10);
    expect(retention(3, 4)).toBeCloseTo(0.5, 10);
    expect(retention(5, 16)).toBeCloseTo(0.5, 10);
  });

  it('keeps decaying past the due date', () => {
    expect(retention(5, 32)).toBeCloseTo(0.25, 10);
    expect(retention(5, 48)).toBeCloseTo(0.125, 10);
  });

  it('never exceeds 1 for a negative or zero elapsed time', () => {
    expect(retention(2, -5)).toBe(1);
  });
});

describe('strength', () => {
  it('equals the raw box weight for a just-reviewed word', () => {
    for (const box of [1, 2, 3, 4, 5] as Box[]) {
      expect(strength(box, 0)).toBeCloseTo(BOX_WEIGHT[box], 10);
    }
  });

  it('halves the box weight once the word is due', () => {
    expect(strength(5, 16)).toBeCloseTo(0.5, 10);
    expect(strength(1, 1)).toBeCloseTo(0.1, 10);
  });
});

describe('summarizeProgress', () => {
  it('reports zeros for a user with no words, without dividing by zero', () => {
    const s = summarizeProgress([], 2809, NOW);
    expect(s.wordsLearned).toBe(0);
    expect(s.masteryPercent).toBe(0);
    expect(s.ngslProgressPercent).toBe(0);
    expect(s.needsRefresh).toBe(0);
  });

  it('gives 100% mastery when every word was just reviewed in box 5', () => {
    const words = Array.from({ length: 20 }, () => wordAt(5, 0));
    const s = summarizeProgress(words, 2809, NOW);
    expect(s.wordsLearned).toBe(20);
    expect(s.masteryPercent).toBeCloseTo(100, 6);
    expect(s.needsRefresh).toBe(0);
  });

  it('separates mastery from NGSL coverage', () => {
    // 100 perfectly-known words: mastery is high, coverage is small. v1 only
    // reported the second number, which read as 3.5% and demotivated users.
    const words = Array.from({ length: 100 }, () => wordAt(5, 0));
    const s = summarizeProgress(words, 2809, NOW);
    expect(s.masteryPercent).toBeCloseTo(100, 6);
    expect(s.ngslProgressPercent).toBeCloseTo((100 / 2809) * 100, 6);
  });

  it('counts overdue words as needing a refresh', () => {
    const words = [wordAt(5, 0), wordAt(5, 40), wordAt(1, 3)];
    const s = summarizeProgress(words, 2809, NOW);
    // Only the freshly reviewed box-5 word is above the 0.5 threshold.
    expect(s.needsRefresh).toBe(2);
  });

  it('falls back to firstSeenAt for a word that has never been reviewed', () => {
    const never: ProgressInput = { box: 1, lastReviewedAt: null, firstSeenAt: daysAgo(1) };
    const s = summarizeProgress([never], 2809, NOW);
    expect(s.masteryScore).toBeCloseTo(BOX_WEIGHT[1] * 0.5, 10);
  });

  it('tallies the per-box breakdown', () => {
    const s = summarizeProgress([wordAt(1, 0), wordAt(1, 0), wordAt(4, 0)], 2809, NOW);
    expect(s.byBox).toEqual({ 1: 2, 2: 0, 3: 0, 4: 1, 5: 0 });
  });
});

describe('progressBar', () => {
  it('renders empty, partial, and full bars', () => {
    expect(progressBar(0)).toBe('░░░░░░░░░░');
    expect(progressBar(50)).toBe('▓▓▓▓▓░░░░░');
    expect(progressBar(100)).toBe('▓▓▓▓▓▓▓▓▓▓');
  });

  it('clamps out-of-range input', () => {
    expect(progressBar(150)).toBe('▓▓▓▓▓▓▓▓▓▓');
    expect(progressBar(-10)).toBe('░░░░░░░░░░');
  });
});
