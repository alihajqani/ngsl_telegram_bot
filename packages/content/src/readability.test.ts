import { Lexicon } from '@ngsl/media';
import { describe, expect, it } from 'vitest';
import { scoreReadability, type ReadabilityContext } from './readability.js';

/**
 * A miniature lexicon: bucket 1 is the most frequent (easiest), bucket 9 the
 * rarest. `medicine` is the word being taught, sitting mid-difficulty.
 */
const ENTRIES = [
  { id: 1, lemma: 'the', bucket: 1 },
  { id: 2, lemma: 'be', bucket: 1 },
  { id: 3, lemma: 'doctor', bucket: 3 },
  { id: 4, lemma: 'give', bucket: 2 },
  { id: 5, lemma: 'medicine', bucket: 5 },
  { id: 6, lemma: 'child', bucket: 3 },
  { id: 7, lemma: 'take', bucket: 2 },
  { id: 8, lemma: 'quantum', bucket: 9 },
  { id: 9, lemma: 'perpetual', bucket: 9 },
  { id: 10, lemma: 'sick', bucket: 4 },
];

const context: ReadabilityContext = {
  lexicon: new Lexicon(ENTRIES),
  buckets: new Map(ENTRIES.map((e) => [e.id, e.bucket])),
};

const MEDICINE = 5;
const score = (text: string) => scoreReadability(text, MEDICINE, context).score;

describe('scoreReadability', () => {
  it('scores a clean, well-covered sentence highly', () => {
    const result = scoreReadability(
      'The doctor gave the sick child some medicine.',
      MEDICINE,
      context,
    );
    expect(result.containsTarget).toBe(true);
    expect(result.hardWordCount).toBe(0);
    expect(result.score).toBeGreaterThan(0.7);
  });

  it('returns zero when the sentence lacks the target word', () => {
    // An example that does not contain the word it illustrates is worthless.
    const result = scoreReadability('The doctor gave the child water.', MEDICINE, context);
    expect(result.containsTarget).toBe(false);
    expect(result.score).toBe(0);
  });

  it('penalizes words rarer than the one being taught', () => {
    const easy = score('The doctor gave the child medicine today.');
    const hard = score('The quantum perpetual medicine was given.');
    expect(hard).toBeLessThan(easy);
    expect(scoreReadability('The quantum perpetual medicine was given.', MEDICINE, context).hardWordCount).toBe(2);
  });

  it('penalizes a sentence that opens mid-thought', () => {
    // "But..." continues something the learner cannot see.
    const standalone = score('The doctor gave the child some medicine.');
    const dangling = score('But the doctor gave the child some medicine.');
    expect(dangling).toBeLessThan(standalone);
  });

  it('penalizes sentences that are too short or too long', () => {
    const ideal = score('The doctor gave the sick child some medicine.');
    const tooShort = score('Take medicine.');
    const tooLong = score(
      'The doctor gave the sick child some medicine and then the child took the medicine ' +
        'and the doctor gave the child more medicine again later that day for sure.',
    );
    expect(tooShort).toBeLessThan(ideal);
    expect(tooLong).toBeLessThan(ideal);
  });

  it('rewards a complete, properly punctuated sentence', () => {
    const complete = score('The doctor gave the child some medicine.');
    const fragment = score('the doctor gave the child some medicine');
    expect(fragment).toBeLessThan(complete);
  });

  it('reports coverage as the share of known vocabulary', () => {
    const result = scoreReadability('The doctor gave medicine.', MEDICINE, context);
    // the, doctor, give, medicine — all four resolve.
    expect(result.coverage).toBe(1);
    expect(result.wordCount).toBe(4);
  });

  it('handles empty input without dividing by zero', () => {
    const result = scoreReadability('   ', MEDICINE, context);
    expect(result.score).toBe(0);
    expect(result.wordCount).toBe(0);
  });

  it('matches inflected forms of the target word', () => {
    expect(scoreReadability('The doctor gave out medicines.', MEDICINE, context).containsTarget).toBe(
      true,
    );
  });

  it('always returns a score within [0, 1]', () => {
    for (const text of [
      'medicine',
      'The doctor gave the sick child some medicine.',
      'But quantum perpetual medicine quantum perpetual quantum perpetual medicine',
    ]) {
      const s = score(text);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
