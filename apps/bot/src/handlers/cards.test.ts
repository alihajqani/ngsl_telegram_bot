import type { NewWordCard } from '@ngsl/db';
import { describe, expect, it } from 'vitest';
import { runWithLocale } from '../i18n/i18n.js';
import { buildWordCard } from './cards.js';

const card = (grammar: NewWordCard['grammar']): NewWordCard => ({
  wordId: 1,
  lemma: 'decide',
  definition: 'to choose something',
  bucket: 1,
  grammar,
});

describe('buildWordCard', () => {
  it('shows the part of speech, the word family, the base word and the synonyms', () => {
    const text = runWithLocale('fa', () =>
      buildWordCard(
        card({
          partsOfSpeech: ['verb', 'noun'],
          family: [
            { word: 'decision', pos: 'noun' },
            { word: 'decisive', pos: 'adjective' },
          ],
          baseWord: 'cide',
          synonyms: [
            { word: 'choose', note: 'more everyday' },
            { word: 'settle', note: null },
          ],
        }),
      ),
    );

    expect(text.split('\n')[0]).toBe('<b>decide</b>  <i>فعل / اسم</i>');
    expect(text).toContain('<i>to choose something</i>');
    expect(text).toContain('🌳 هم‌خانواده: decision (اسم) · decisive (صفت)');
    expect(text).toContain('🌱 ریشه: cide');
    expect(text).toContain('• <b>choose</b>: <i>more everyday</i>');
    expect(text).toContain('• <b>settle</b>');
    expect(text).not.toContain('settle</b>:');
  });

  it('is the plain card until the word has details', () => {
    const text = runWithLocale('fa', () => buildWordCard(card(null)));
    expect(text).toBe('<b>decide</b>\n<i>to choose something</i>');
  });

  it('leaves out the lines a word has nothing for, as for "the"', () => {
    const text = runWithLocale('en', () =>
      buildWordCard({
        ...card({ partsOfSpeech: ['determiner'], family: [], baseWord: null, synonyms: [] }),
        lemma: 'the',
        definition: null,
      }),
    );
    expect(text).toBe('<b>the</b>  <i>determiner</i>');
  });

  it('escapes what the model wrote', () => {
    const text = runWithLocale('en', () =>
      buildWordCard(
        card({
          partsOfSpeech: ['verb'],
          family: [],
          baseWord: null,
          synonyms: [{ word: 'choose', note: 'A & B <both>' }],
        }),
      ),
    );
    expect(text).toContain('A &amp; B &lt;both&gt;');
  });
});
