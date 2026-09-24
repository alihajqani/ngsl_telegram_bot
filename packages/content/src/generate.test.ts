import { describe, expect, it } from 'vitest';
import { collocationBatchSchema, exampleBatchSchema } from './generate.js';

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
