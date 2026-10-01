import type * as Db from '@ngsl/db';
import type { Database, WordNeedingContent } from '@ngsl/db';
import type * as Llm from '@ngsl/llm';
import { AllKeysExhaustedError } from '@ngsl/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { completeJson, saveWordDetail, wordsMissingCollocations, wordsMissingDetails, wordsMissingExamples } =
  vi.hoisted(() => ({
    completeJson: vi.fn(),
    saveWordDetail: vi.fn(),
    wordsMissingCollocations: vi.fn(),
    wordsMissingDetails: vi.fn(),
    wordsMissingExamples: vi.fn(),
  }));

vi.mock('@ngsl/db', async (importOriginal) => ({
  PARTS_OF_SPEECH: (await importOriginal<typeof Db>()).PARTS_OF_SPEECH,
  db: () => ({}),
  saveCollocations: vi.fn(),
  saveLlmExamples: vi.fn(),
  saveWordDetail,
  wordsMissingCollocations,
  wordsMissingDetails,
  wordsMissingExamples,
}));
vi.mock('@ngsl/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof Llm>()),
  completeJson,
}));
vi.mock('@ngsl/shared', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const {
  cleanDetail,
  collocationBatchSchema,
  detailBatchSchema,
  exampleBatchSchema,
  generateCollocations,
  generateExamples,
  generateWordDetails,
} = await import('./generate.js');

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

describe('word details', () => {
  const entry = (raw: unknown) => detailBatchSchema.parse({ words: [raw] }).words[0]!;

  it('keeps a well-formed entry as it is', () => {
    const detail = cleanDetail(
      'decide',
      entry({
        word: 'decide',
        pos: ['verb'],
        family: [
          { word: 'decision', pos: 'noun' },
          { word: 'decisive', pos: 'adjective' },
        ],
        base: null,
        synonyms: [{ word: 'choose', note: 'more everyday' }],
      }),
    );
    expect(detail).toEqual({
      partsOfSpeech: ['verb'],
      family: [
        { word: 'decision', pos: 'noun' },
        { word: 'decisive', pos: 'adjective' },
      ],
      baseWord: null,
      synonyms: [{ word: 'choose', note: 'more everyday' }],
    });
  });

  it('drops a bad item, not the word: unknown parts of speech, phrases, the headword', () => {
    const detail = cleanDetail(
      'Happy',
      entry({
        word: 'happy',
        pos: ['Adjective', 'gerund'],
        family: [
          { word: 'happiness', pos: 'noun' },
          { word: 'happy', pos: 'adjective' },
          { word: 'very happy', pos: 'adjective' },
          { word: 'happily', pos: 'manner' },
          'unhappy',
          { word: 'Happiness', pos: 'noun' },
        ],
        base: 'happy',
        synonyms: [{ word: 'glad' }, { word: 'over the moon', note: 'idiom' }, { word: 'glad' }],
      }),
    );
    expect(detail).toEqual({
      partsOfSpeech: ['adjective'],
      family: [{ word: 'happiness', pos: 'noun' }],
      baseWord: null,
      synonyms: [{ word: 'glad', note: null }],
    });
  });

  it('reads "the" answered as an article', () => {
    const detail = cleanDetail('the', entry({ word: 'the', pos: 'article' }));
    expect(detail).toEqual({ partsOfSpeech: ['determiner'], family: [], baseWord: null, synonyms: [] });
  });

  it('keeps the base word of a derived word, and out of its family', () => {
    const detail = cleanDetail(
      'government',
      entry({
        word: 'government',
        pos: ['noun'],
        base: 'Govern',
        family: [
          { word: 'govern', pos: 'verb' },
          { word: 'governor', pos: 'noun' },
        ],
      }),
    );
    expect(detail?.baseWord).toBe('govern');
    expect(detail?.family).toEqual([{ word: 'governor', pos: 'noun' }]);
  });

  it('leaves a word with no known part of speech for the next run', () => {
    expect(cleanDetail('xyz', entry({ word: 'xyz', pos: ['thing'] }))).toBeUndefined();
  });

  it('caps the family at 5 and the synonyms at 3', () => {
    const detail = cleanDetail(
      'act',
      entry({
        word: 'act',
        pos: ['verb', 'noun'],
        family: ['action', 'active', 'actively', 'activity', 'actor', 'actress'].map((word) => ({
          word,
          pos: 'noun',
        })),
        synonyms: ['do', 'perform', 'behave', 'work'].map((word) => ({ word })),
      }),
    );
    expect(detail?.family).toHaveLength(5);
    expect(detail?.synonyms).toHaveLength(3);
  });

  /** Eight entries ran past the server's 180 s request timeout on every batch. */
  it('asks for 4 words a request', async () => {
    wordsMissingDetails.mockResolvedValue(words(10));
    completeJson.mockReset().mockResolvedValue({ words: [] });

    await generateWordDetails({}, database);

    expect(completeJson).toHaveBeenCalledTimes(3);
  });

  it('saves only the words it was asked about', async () => {
    wordsMissingDetails.mockResolvedValue([{ wordId: 7, lemma: 'decide', definition: null, have: 0 }]);
    completeJson.mockResolvedValue(
      detailBatchSchema.parse({
        words: [
          { word: 'decide', pos: ['verb'] },
          { word: 'unrelated', pos: ['adjective'] },
        ],
      }),
    );
    saveWordDetail.mockReset();

    const stats = await generateWordDetails({}, database);

    expect(saveWordDetail).toHaveBeenCalledTimes(1);
    expect(saveWordDetail).toHaveBeenCalledWith(
      { wordId: 7, partsOfSpeech: ['verb'], family: [], baseWord: null, synonyms: [] },
      database,
    );
    expect(stats.wordsWritten).toBe(1);
  });
});
