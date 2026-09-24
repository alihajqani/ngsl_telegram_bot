import { describe, expect, it } from 'vitest';
import { highlightForms, highlightMarked } from './highlight.js';

describe('highlightForms', () => {
  it('bolds every token that is one of the forms, whatever its case', () => {
    expect(highlightForms('She went home. Went twice!', ['went'])).toBe(
      'She <b>went</b> home. <b>Went</b> twice!',
    );
  });

  it('matches curly-apostrophe contractions against straight-apostrophe forms', () => {
    expect(highlightForms('I don’t know.', ["don't"])).toBe('I <b>don’t</b> know.');
  });

  it('does not bold a form inside a longer word', () => {
    expect(highlightForms('Going, not go.', ['go'])).toBe('Going, not <b>go</b>.');
  });

  it('escapes the sentence, which comes from subtitles', () => {
    expect(highlightForms('Salt & <pepper> go', ['go'])).toBe('Salt &amp; &lt;pepper&gt; <b>go</b>');
  });

  it('leaves the sentence plain when there are no forms', () => {
    expect(highlightForms('A < B', [])).toBe('A &lt; B');
  });
});

describe('highlightMarked', () => {
  it('turns the database search markers into bold tags after escaping', () => {
    expect(highlightMarked('look \u0001forward\u0002 to <it>')).toBe('look <b>forward</b> to &lt;it&gt;');
  });
});
