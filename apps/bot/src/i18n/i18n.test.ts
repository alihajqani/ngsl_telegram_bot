import { describe, expect, it } from 'vitest';
import { currentLocale, detectLocale, escapeHtml, runWithLocale, t } from './i18n.js';

describe('runWithLocale', () => {
  it('scopes the locale to the callback', () => {
    runWithLocale('en', () => expect(currentLocale()).toBe('en'));
    runWithLocale('fa', () => expect(currentLocale()).toBe('fa'));
  });

  it('falls back to Persian outside any request scope', () => {
    expect(currentLocale()).toBe('fa');
  });

  it('survives an await boundary', async () => {
    await runWithLocale('en', async () => {
      await Promise.resolve();
      expect(currentLocale()).toBe('en');
    });
  });
});

describe('t', () => {
  it('resolves a dot-path key in the active locale', () => {
    runWithLocale('en', () => expect(t('menu.review')).toBe('🔄 Review'));
    runWithLocale('fa', () => expect(t('menu.review')).toBe('🔄 مرور'));
  });

  it('interpolates variables', () => {
    runWithLocale('en', () => {
      expect(t('review.correct', { lemma: 'apple', box: 3 })).toBe(
        '✅ Nice! <b>apple</b> moved to box 3.',
      );
    });
  });

  it('leaves an unknown placeholder untouched rather than printing undefined', () => {
    runWithLocale('en', () => {
      expect(t('review.correct', { lemma: 'apple' })).toContain('{box}');
    });
  });

  it('returns the key itself when it does not exist', () => {
    // A visible broken string beats a thrown exception mid-session.
    runWithLocale('en', () => expect(t('nope.missing')).toBe('nope.missing'));
  });
});

describe('detectLocale', () => {
  it('maps Persian language codes to fa', () => {
    expect(detectLocale('fa')).toBe('fa');
    expect(detectLocale('fa-IR')).toBe('fa');
  });

  it('maps everything else to en', () => {
    expect(detectLocale('en-US')).toBe('en');
    expect(detectLocale('de')).toBe('en');
    expect(detectLocale(undefined)).toBe('en');
  });
});

describe('escapeHtml', () => {
  it('escapes the characters Telegram HTML mode treats as markup', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('leaves ordinary corpus text alone', () => {
    expect(escapeHtml("It's so light that you can barely feel it.")).toBe(
      "It's so light that you can barely feel it.",
    );
  });
});
