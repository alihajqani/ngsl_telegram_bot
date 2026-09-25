import { describe, expect, it } from 'vitest';
import { runWithLocale, t } from './i18n/i18n.js';
import {
  boardsNavKeyboard,
  CB_PATTERN,
  clipKeyboard,
  isEnglishQuery,
  mainMenuKeyboard,
  MENU_LAYOUT,
  menuKeyFor,
  withoutNextWord,
  wordCardKeyboard,
  type MenuKey,
} from './keyboards.js';

const labels = (keyboard: ReturnType<typeof mainMenuKeyboard>): string[] =>
  keyboard.build().flat().map((button) => (typeof button === 'string' ? button : button.text));

const callbacks = (keyboard: ReturnType<typeof boardsNavKeyboard>): string[] =>
  keyboard.inline_keyboard.flat().map((button) => ('callback_data' in button ? button.callback_data : ''));

const LEARNER_KEYS: MenuKey[] = MENU_LAYOUT.flat();

describe('mainMenuKeyboard', () => {
  it('puts every learner feature on a button, including the league and the Lazy Board', () => {
    expect(LEARNER_KEYS).toEqual(
      expect.arrayContaining([
        'newWords', 'review', 'writing', 'progress', 'streak', 'league', 'lazy', 'search', 'settings',
      ]),
    );
    for (const locale of ['fa', 'en'] as const) {
      runWithLocale(locale, () => {
        const shown = labels(mainMenuKeyboard());
        for (const key of LEARNER_KEYS) expect(shown).toContain(t(`menu.${key}`));
      });
    }
  });

  it('shows the admin button to admins only', () => {
    runWithLocale('fa', () => {
      expect(labels(mainMenuKeyboard())).not.toContain(t('menu.admin'));
      expect(labels(mainMenuKeyboard({ admin: true }))).toContain(t('menu.admin'));
    });
  });

  it('has no empty rows, which Telegram renders as gaps', () => {
    expect(mainMenuKeyboard({ admin: true }).build().every((row) => row.length > 0)).toBe(true);
  });

  it('can be hidden, so the back button on a phone closes it', () => {
    // `is_persistent` keeps the menu on screen for good: Android's back button
    // then leaves the chat instead of closing the menu.
    expect(mainMenuKeyboard().is_persistent).toBeFalsy();
  });
});

describe('menuKeyFor', () => {
  it('maps every label back to its button in both languages', () => {
    for (const locale of ['fa', 'en'] as const) {
      runWithLocale(locale, () => {
        for (const key of [...LEARNER_KEYS, 'admin' as const]) {
          const label = t(`menu.${key}`);
          expect(label).not.toBe(`menu.${key}`); // a missing string falls back to its key
          expect(menuKeyFor(label)).toBe(key);
        }
      });
    }
  });

  it('ignores ordinary text', () => {
    runWithLocale('fa', () => expect(menuKeyFor('hello')).toBeUndefined());
  });
});

describe('boardsNavKeyboard', () => {
  it('links to the other two boards', () => {
    runWithLocale('fa', () => {
      expect(callbacks(boardsNavKeyboard('league'))).toEqual(['global', 'lazy']);
      expect(callbacks(boardsNavKeyboard('global'))).toEqual(['league', 'lazy']);
      expect(callbacks(boardsNavKeyboard('lazy'))).toEqual(['league', 'global']);
    });
  });
});

describe('wordCardKeyboard', () => {
  const data = (kb: ReturnType<typeof wordCardKeyboard>) =>
    kb.inline_keyboard.flat().map((b) => ('callback_data' in b ? b.callback_data : ''));

  it('leads to the next card, numbered, while the session has more', () => {
    runWithLocale('en', () => {
      const kb = wordCardKeyboard(12, 'take', { position: 2, total: 20 });
      expect(data(kb)).toContain('nx:12');
      expect(kb.inline_keyboard.at(-1)?.[0]?.text).toContain('2/20');
    });
  });

  it('has no next button on the last card', () => {
    runWithLocale('en', () => {
      expect(data(wordCardKeyboard(12, 'take')).some((d) => d.startsWith('nx:'))).toBe(false);
    });
  });

  it('drops only the next button once it is used, and the row it leaves empty', () => {
    runWithLocale('en', () => {
      const withNext = wordCardKeyboard(12, 'take', { position: 2, total: 20 }).inline_keyboard;
      expect(withoutNextWord(withNext)).toEqual(wordCardKeyboard(12, 'take').inline_keyboard);
    });
  });

  it('matches its own callback data', () => {
    expect(CB_PATTERN.nextWord.exec('nx:12')?.[1]).toBe('12');
  });
});

describe('clipKeyboard', () => {
  const clip = { segmentId: 77, ytVideoId: 'abc123', startMs: 61_900 };
  const buttons = (kb: ReturnType<typeof clipKeyboard>) => kb.inline_keyboard.flat();
  const data = (kb: ReturnType<typeof clipKeyboard>) =>
    buttons(kb).map((b) => ('callback_data' in b ? b.callback_data : 'url' in b ? b.url : ''));

  it('wraps around at both ends, like a player', () => {
    runWithLocale('fa', () => {
      expect(data(clipKeyboard('w5', 0, 3, clip)).slice(0, 2)).toEqual(['cv:w5:2', 'cv:w5:1']);
      expect(data(clipKeyboard('w5', 2, 3, clip)).slice(0, 2)).toEqual(['cv:w5:1', 'cv:w5:0']);
    });
  });

  it('drops the arrows when there is only one clip', () => {
    runWithLocale('fa', () => {
      expect(data(clipKeyboard('q', 0, 1, clip)).some((d) => d.startsWith('cv:'))).toBe(false);
    });
  });

  it('votes on the sentence and links to the moment on YouTube', () => {
    runWithLocale('fa', () => {
      const all = data(clipKeyboard('q', 0, 2, clip));
      expect(all).toContain('vt:77:l');
      expect(all).toContain('vt:77:d');
      expect(all).toContain('https://www.youtube.com/watch?v=abc123&t=61s');
    });
  });

  it('produces callback data the routes understand', () => {
    runWithLocale('fa', () => {
      for (const d of data(clipKeyboard('w2809', 1, 30, clip))) {
        if (d.startsWith('cv:')) expect(CB_PATTERN.clipNav.test(d)).toBe(true);
        if (d.startsWith('vt:')) expect(CB_PATTERN.clipVote.test(d)).toBe(true);
        expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
      }
    });
  });
});

describe('isEnglishQuery', () => {
  it('accepts a word or a short phrase typed in English', () => {
    expect(isEnglishQuery('apple')).toBe(true);
    expect(isEnglishQuery('look forward to')).toBe(true);
    expect(isEnglishQuery("don't")).toBe(true);
  });

  it('rejects Persian, commands, digits and long text', () => {
    expect(isEnglishQuery('سیب')).toBe(false);
    expect(isEnglishQuery('/start')).toBe(false);
    expect(isEnglishQuery('route 66')).toBe(false);
    expect(isEnglishQuery('one two three four five six seven')).toBe(false);
  });
});
