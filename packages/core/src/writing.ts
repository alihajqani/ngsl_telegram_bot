import type { Box } from './leitner.js';

/**
 * Which words a writing exercise asks the learner to use — pure, no I/O.
 *
 * Words come from every box, but the first boxes are favoured: writing with a
 * word is how a shaky word becomes a mastered one, so the exercise leans on the
 * words still being learned, while a mastered word still turns up now and then
 * so it stays in use.
 */

/** Relative chance of each box filling a slot. */
export const WRITING_BOX_WEIGHT: Readonly<Record<Box, number>> = {
  1: 5,
  2: 4,
  3: 3,
  4: 2,
  5: 1,
};

const BOXES: readonly Box[] = [1, 2, 3, 4, 5];

/**
 * Pick up to `count` distinct words from the learner's deck.
 *
 * Each slot draws a box first (among the boxes that still have words), then a
 * word inside it. Weighting the box rather than the word matters: fifty words
 * marked "I know this" sit in box 5, and weighted one by one they would crowd
 * out the five the learner is actually struggling with.
 */
export function pickWritingWords<T extends { box: Box }>(
  candidates: readonly T[],
  count: number,
  random: () => number = Math.random,
): T[] {
  const byBox = new Map<Box, T[]>();
  for (const candidate of candidates) {
    const pool = byBox.get(candidate.box) ?? [];
    pool.push(candidate);
    byBox.set(candidate.box, pool);
  }

  const picked: T[] = [];
  while (picked.length < count) {
    const boxes = BOXES.filter((box) => (byBox.get(box)?.length ?? 0) > 0);
    if (boxes.length === 0) break;

    const total = boxes.reduce((sum, box) => sum + WRITING_BOX_WEIGHT[box], 0);
    let roll = random() * total;
    let box = boxes[boxes.length - 1]!;
    for (const candidate of boxes) {
      roll -= WRITING_BOX_WEIGHT[candidate];
      if (roll < 0) {
        box = candidate;
        break;
      }
    }

    const pool = byBox.get(box)!;
    picked.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  }

  return picked;
}
