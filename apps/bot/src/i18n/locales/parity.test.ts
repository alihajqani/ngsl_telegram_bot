import { describe, expect, it } from 'vitest';
import { en } from './en.js';
import { fa } from './fa.js';

/**
 * Structural typing already requires every Persian key to exist in English.
 * This adds the two guarantees the type system does not give:
 *   - no *extra* English keys that no Persian string backs
 *   - no untranslated string that is byte-identical to the Persian original
 */

function flatten(node: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node !== 'object' || node === null) return out;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const faKeys = flatten(fa);
const enKeys = flatten(en);

describe('locale catalogues', () => {
  it('define exactly the same keys', () => {
    expect([...enKeys.keys()].sort()).toEqual([...faKeys.keys()].sort());
  });

  it('has no empty strings', () => {
    for (const [key, value] of [...faKeys, ...enKeys]) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('uses the same interpolation placeholders in both languages', () => {
    // A placeholder present in one language but not the other renders as a
    // literal "{count}" to half the user base.
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, faValue] of faKeys) {
      expect(placeholders(enKeys.get(key) ?? ''), key).toEqual(placeholders(faValue));
    }
  });

  it('leaves no English string identical to its Persian source', () => {
    // Values that are only markup, placeholders and emoji — "<b>{lemma}</b>" —
    // are legitimately identical across languages. Strip those before deciding
    // whether a string carries prose that ought to have been translated.
    const prose = (s: string) =>
      s
        .replace(/<\/?\w+>/g, '')
        .replace(/\{\w+\}/g, '')
        .replace(/[^a-zA-Z؀-ۿ]/g, '');

    for (const [key, faValue] of faKeys) {
      if (prose(faValue) === '') continue;
      expect(enKeys.get(key), key).not.toBe(faValue);
    }
  });

  it('keeps HTML tags balanced', () => {
    for (const [key, value] of [...faKeys, ...enKeys]) {
      const open = (value.match(/<(b|i|code)>/g) ?? []).length;
      const close = (value.match(/<\/(b|i|code)>/g) ?? []).length;
      expect(open, key).toBe(close);
    }
  });
});
