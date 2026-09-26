import type { Database, WordNeedingContent } from '@ngsl/db';
import type * as Llm from '@ngsl/llm';
import { AllKeysExhaustedError } from '@ngsl/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { completeJson, wordsMissingCollocations, wordsMissingExamples } = vi.hoisted(() => ({
  completeJson: vi.fn(),
  wordsMissingCollocations: vi.fn(),
  wordsMissingExamples: vi.fn(),
}));

vi.mock('@ngsl/db', () => ({
  db: () => ({}),
  saveCollocations: vi.fn(),
  saveLlmExamples: vi.fn(),
  wordsMissingCollocations,
  wordsMissingExamples,
}));
vi.mock('@ngsl/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof Llm>()),
  completeJson,
}));
vi.mock('@ngsl/shared', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { collocationBatchSchema, exampleBatchSchema, generateCollocations, generateExamples } =
  await import('./generate.js');

const database = {} as Database;
const words = (n: number): WordNeedingContent[] =>
  Array.from({ length: n }, (_, i) => ({ wordId: i + 1, lemma: `w${i}`, definition: null, have: 0 }));

describe('batch schemas', () => {
  it('accept the requested {"words": [...]} shape', () => {
    const parsed = exampleBatchSchema.parse({ words: [{ word: 'run', examples: ['I run daily.'] }] });
    expect(parsed.words[0]?.word).toBe('run');
  });

  it('also accept a bare array, which the model sometimes returns', () => {
    const parsed = exampleBatchSchema.parse([{ word: 'run', examples: ['I run daily.'] }]);
    expect(parsed.words).toHaveLength(1);

    const phrases = collocationBatchSchema.parse([
      { word: 'break', phrases: [{ phrase: 'break the ice', meaning: 'ease awkwardness', kind: 'idiom' }] },
    ]);
    expect(phrases.words[0]?.phrases[0]?.kind).toBe('idiom');
  });
});

describe('a generation pass', () => {
  const START = new Date('2026-09-26T08:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    completeJson.mockReset();
    wordsMissingCollocations.mockResolvedValue(words(3));
    wordsMissingExamples.mockResolvedValue(words(3));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Each simulated LLM call takes a minute. */
  const slowAnswer = () => {
    vi.setSystemTime(Date.now() + 60_000);
    return Promise.resolve({ words: [] });
  };

  it('starts no new batch once its deadline has passed', async () => {
    completeJson.mockImplementation(slowAnswer);

    const stats = await generateCollocations({ batchSize: 1, deadline: START + 90_000 }, database);

    // Batches start at 0 s and 60 s; at 120 s the deadline has passed.
    expect(completeJson).toHaveBeenCalledTimes(2);
    expect(stats.wordsConsidered).toBe(3);
  });

  it('keeps to the deadline for examples too', async () => {
    completeJson.mockImplementation(slowAnswer);

    await generateExamples({ batchSize: 1, deadline: START + 30_000 }, database);

    expect(completeJson).toHaveBeenCalledTimes(1);
  });

  /**
   * Every later batch would hit the same exhausted keys, and each failure is a
   * warning mirrored to the monitor topic: carrying on would only spam it.
   */
  it('stops when every API key is rate limited', async () => {
    completeJson.mockRejectedValue(new AllKeysExhaustedError('gemini'));

    const stats = await generateCollocations({ batchSize: 1 }, database);

    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(stats.batchesFailed).toBe(1);
  });

  it('carries on past an ordinary failed batch', async () => {
    completeJson.mockRejectedValueOnce(new Error('malformed JSON'));
    completeJson.mockResolvedValue({ words: [] });

    const stats = await generateCollocations({ batchSize: 1 }, database);

    expect(completeJson).toHaveBeenCalledTimes(3);
    expect(stats.batchesFailed).toBe(1);
  });
});
