/**
 * Leitner scheduling — pure functions, no I/O.
 *
 * v1 kept two parallel implementations: unused Mongoose document methods and
 * the real atomic repository update. There is exactly one here, and the
 * repository is a thin persistence wrapper around it.
 */

export type Box = 1 | 2 | 3 | 4 | 5;

export const MIN_BOX: Box = 1;
export const MAX_BOX: Box = 5;

/** Box 5 is "mastered"; the ladder is unchanged from v1. */
export const BOX_INTERVAL_DAYS: Readonly<Record<Box, number>> = {
  1: 1,
  2: 2,
  3: 4,
  4: 8,
  5: 16,
};

export type ReviewResult = 'correct' | 'wrong' | 'known';

export interface LeitnerState {
  box: Box;
  reviewCount: number;
  nextReviewAt: Date;
  lastReviewedAt: Date | null;
}

const DAY_MS = 86_400_000;

export function isBox(value: number): value is Box {
  return Number.isInteger(value) && value >= MIN_BOX && value <= MAX_BOX;
}

/** Clamp any integer into the valid box range. */
export function toBox(value: number): Box {
  return Math.min(MAX_BOX, Math.max(MIN_BOX, Math.round(value))) as Box;
}

/**
 * Box transition.
 *
 * `known` is the "I know this" button: it jumps straight to the final box
 * rather than climbing the ladder one review at a time.
 */
export function nextBox(current: Box, result: ReviewResult): Box {
  switch (result) {
    case 'correct':
      return toBox(current + 1);
    case 'wrong':
      return MIN_BOX;
    case 'known':
      return MAX_BOX;
  }
}

export function nextReviewAt(box: Box, from: Date): Date {
  return new Date(from.getTime() + BOX_INTERVAL_DAYS[box] * DAY_MS);
}

/** A newly introduced word: box 1, due tomorrow. */
export function initialState(now: Date): LeitnerState {
  return {
    box: MIN_BOX,
    reviewCount: 0,
    nextReviewAt: nextReviewAt(MIN_BOX, now),
    lastReviewedAt: null,
  };
}

/** Apply a review answer. The scheduled interval always follows the NEW box. */
export function applyReview(state: LeitnerState, result: ReviewResult, now: Date): LeitnerState {
  const box = nextBox(state.box, result);
  return {
    box,
    reviewCount: state.reviewCount + 1,
    nextReviewAt: nextReviewAt(box, now),
    lastReviewedAt: now,
  };
}

export function isDue(state: LeitnerState, now: Date): boolean {
  return state.nextReviewAt.getTime() <= now.getTime();
}
