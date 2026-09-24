import { describe, expect, it } from 'vitest';
import { Lexicon } from './lexicon.js';

const LEMMAS = [
  'apple', 'fall', 'tree', 'go', 'mouse', 'good', 'child', 'do', 'not', 'be',
  'it', 'have', 'run', 'study', 'happy', 'let', 'us', 'we',
];

const lexicon = new Lexicon(LEMMAS.map((lemma, i) => ({ id: i + 1, lemma })));
const id = (lemma: string) => LEMMAS.indexOf(lemma) + 1;

const matched = (text: string) => {
  const ids = lexicon.match(text);
  return LEMMAS.filter((l) => ids.has(id(l)));
};

describe('Lexicon.resolve', () => {
  it('matches a literal lemma', () => {
    expect(lexicon.resolve('apple')).toBe(id('apple'));
  });

  it('is case-insensitive', () => {
    expect(lexicon.resolve('APPLE')).toBe(id('apple'));
  });

  it('resolves regular inflections to their lemma', () => {
    expect(lexicon.resolve('apples')).toBe(id('apple'));
    expect(lexicon.resolve('falling')).toBe(id('fall'));
    expect(lexicon.resolve('studied')).toBe(id('study'));
    expect(lexicon.resolve('trees')).toBe(id('tree'));
  });

  it('resolves irregular forms — the reason a suffix-stripper is not enough', () => {
    expect(lexicon.resolve('went')).toBe(id('go'));
    expect(lexicon.resolve('mice')).toBe(id('mouse'));
    expect(lexicon.resolve('children')).toBe(id('child'));
    expect(lexicon.resolve('better')).toBe(id('good'));
    expect(lexicon.resolve('happiest')).toBe(id('happy'));
  });

  it('returns undefined for words outside the vocabulary', () => {
    expect(lexicon.resolve('quixotic')).toBeUndefined();
    expect(lexicon.resolve('')).toBeUndefined();
  });
});

describe('Lexicon.match', () => {
  it('finds every NGSL word in a sentence', () => {
    expect(matched('The apples fell from the trees.')).toEqual(['apple', 'fall', 'tree']);
  });

  it('deduplicates repeats of the same lemma', () => {
    expect(lexicon.match('apple apple apples').size).toBe(1);
  });

  it('expands contractions into their component words', () => {
    // "don't" hides both `do` and `not`, two of NGSL's highest-frequency entries.
    expect(matched("I don't run")).toEqual(['do', 'not', 'run']);
    expect(matched("let's go")).toEqual(['go', 'let', 'us']);
    expect(matched("it's good")).toEqual(['good', 'be', 'it']);
  });

  it('handles typographic apostrophes as used in real subtitles', () => {
    // TED and English Speeches write "Don’t" with U+2019. Matching only U+0027
    // silently loses `do` and `not` on a large share of the corpus.
    expect(matched('Don’t run')).toEqual(['do', 'not', 'run']);
    expect(matched('It’s good')).toEqual(['good', 'be', 'it']);
    expect(lexicon.resolve('apple’s')).toBe(id('apple'));
  });

  it('ignores punctuation and digits', () => {
    expect(matched('Apple, 42 trees -- good!')).toEqual(['apple', 'tree', 'good']);
  });

  it('does not produce junk tokens from apostrophes', () => {
    // Naive splitting on apostrophes yields a stray "t" from "don't".
    expect(lexicon.resolve('t')).toBeUndefined();
  });

  it('returns an empty set for text with no vocabulary hits', () => {
    expect(lexicon.match('zzz qqq').size).toBe(0);
  });
});

describe('Lexicon.matchForms', () => {
  const forms = (text: string, lemma: string) => lexicon.matchForms(text).get(id(lemma));

  it('records the surface forms each word appeared as', () => {
    expect(forms('The Apples fell, and an apple fell again.', 'apple')).toEqual(['apples', 'apple']);
    expect(forms('She went home; we go too.', 'go')).toEqual(['went', 'go']);
  });

  it('records a contraction as the form of each word inside it', () => {
    expect(forms('I don’t know.', 'do')).toEqual(["don't"]);
    expect(forms('I don’t know.', 'not')).toEqual(["don't"]);
  });

  it('agrees with match on which words are present', () => {
    const text = 'The children didn’t run to the trees.';
    expect(new Set(lexicon.matchForms(text).keys())).toEqual(lexicon.match(text));
  });
});
