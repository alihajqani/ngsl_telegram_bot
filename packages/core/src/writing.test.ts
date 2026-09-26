import { describe, expect, it } from 'vitest';
import type { Box } from './leitner.js';
import { pickWritingWords, WRITING_BOX_WEIGHT } from './writing.js';

interface Candidate {
  lemma: string;
  box: Box;
}

const inBox = (box: Box, n: number): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({ lemma: `b${box}-${i}`, box }));

/** Deterministic PRNG (mulberry32), so the distribution tests cannot flake. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('pickWritingWords', () => {
  /** The reported bug: a learner whose words are all in the first boxes got nothing. */
  it('fills every slot from the first boxes alone', () => {
    const picked = pickWritingWords([...inBox(1, 4), ...inBox(2, 3)], 5, seeded(1));
    expect(picked).toHaveLength(5);
  });

  it('never picks the same word twice', () => {
    const picked = pickWritingWords([...inBox(1, 3), ...inBox(4, 3)], 5, seeded(2));
    expect(new Set(picked.map((c) => c.lemma)).size).toBe(5);
  });

  it('returns every candidate when there are fewer than asked for', () => {
    const candidates = [...inBox(1, 1), ...inBox(5, 1)];
    expect(pickWritingWords(candidates, 5, seeded(3))).toHaveLength(2);
  });

  it('returns nothing for an empty deck', () => {
    expect(pickWritingWords([], 5, seeded(4))).toEqual([]);
  });

  it('draws the box first, from the lowest non-empty box up', () => {
    const candidates = [...inBox(3, 1), ...inBox(1, 1), ...inBox(2, 1)];
    const picked = pickWritingWords(candidates, 3, () => 0);
    expect(picked.map((c) => c.box)).toEqual([1, 2, 3]);
  });

  /**
   * Weighting the box rather than the word: fifty "I know this" words in box 5
   * must not crowd out the five the learner is still struggling with.
   */
  it('favours the first boxes however full the last one is', () => {
    const candidates = [...inBox(1, 5), ...inBox(5, 50)];
    const random = seeded(5);
    let fromBoxOne = 0;
    const trials = 6_000;
    for (let i = 0; i < trials; i++) {
      if (pickWritingWords(candidates, 1, random)[0]!.box === 1) fromBoxOne += 1;
    }
    const expected = WRITING_BOX_WEIGHT[1] / (WRITING_BOX_WEIGHT[1] + WRITING_BOX_WEIGHT[5]);
    expect(fromBoxOne / trials).toBeCloseTo(expected, 1);
  });

  it('weights box 1 heaviest and box 5 lightest', () => {
    const weights = ([1, 2, 3, 4, 5] as Box[]).map((box) => WRITING_BOX_WEIGHT[box]);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
    expect(weights[0]).toBeGreaterThan(weights[4]!);
  });
});
