import { describe, expect, it } from 'vitest';
import { runWithLocale, t } from './i18n/i18n.js';
import { boardsNavKeyboard, mainMenuKeyboard, MENU_LAYOUT, menuKeyFor, type MenuKey } from './keyboards.js';

const labels = (keyboard: ReturnType<typeof mainMenuKeyboard>): string[] =>
  keyboard.build().flat().map((button) => (typeof button === 'string' ? button : button.text));

const callbacks = (keyboard: ReturnType<typeof boardsNavKeyboard>): string[] =>
  keyboard.inline_keyboard.flat().map((button) => ('callback_data' in button ? button.callback_data : ''));

const LEARNER_KEYS: MenuKey[] = MENU_LAYOUT.flat();

describe('mainMenuKeyboard', () => {
  it('puts every learner feature on a button, including the league and the Lazy Board', () => {
    expect(LEARNER_KEYS).toEqual(
      expect.arrayContaining(['newWords', 'review', 'writing', 'progress', 'streak', 'league', 'lazy', 'settings']),
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
