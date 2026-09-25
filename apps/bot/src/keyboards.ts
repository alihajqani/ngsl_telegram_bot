import { InlineKeyboard, Keyboard } from 'grammy';
import { t } from './i18n/i18n.js';

/**
 * Callback data is capped at 64 bytes by Telegram, so the encoding is terse:
 * a two-letter action plus an integer id. Anything richer belongs in the
 * session or the database, not in a button.
 */
export const CB = {
  examples: (wordId: number) => `ex:${wordId}`,
  collocations: (wordId: number) => `co:${wordId}`,
  clips: (wordId: number) => `cl:${wordId}`,
  review: (result: 'c' | 'w' | 'k', wordId: number) => `rv:${result}:${wordId}`,
  checkMembership: 'chk',
  league: 'league',
  global: 'global',
  lazy: 'lazy',
  buddy: 'buddy',
  broadcast: 'adm:bc',
  broadcastCancel: 'adm:cx',
  /** Sent by the worker under the nightly boards message. */
  digestOff: 'dg:off',
  /** Move within a clip deck. `deck` is `w<wordId>` for a word, `q` for a search. */
  clipNav: (deck: string, position: number) => `cv:${deck}:${position}`,
  clipVote: (segmentId: number, vote: 'l' | 'd') => `vt:${segmentId}:${vote}`,
} as const;

export const CB_PATTERN = {
  examples: /^ex:(\d+)$/,
  collocations: /^co:(\d+)$/,
  clips: /^cl:(\d+)$/,
  review: /^rv:([cwk]):(\d+)$/,
  clipNav: /^cv:(w\d+|q):(\d+)$/,
  clipVote: /^vt:(\d+):([ld])$/,
} as const;

/**
 * Every learner feature has a reply-keyboard button, in this order. Commands
 * exist too, but nothing should be reachable only by typing one. The routes
 * live in `index.ts` as a `Record<MenuKey, …>`, so a button without a handler
 * fails the build.
 */
export const MENU_LAYOUT = [
  ['newWords', 'review'],
  ['search', 'writing'],
  ['progress', 'streak'],
  ['league', 'lazy'],
  ['settings'],
] as const;

export type MenuKey = (typeof MENU_LAYOUT)[number][number] | 'admin';

/**
 * The main menu. The admin button is added for admins only.
 *
 * Deliberately not `persistent()`: a persistent keyboard cannot be hidden, so
 * the back button on Android left the chat instead of closing the menu. The
 * keyboard icon beside the input field brings it back.
 */
export function mainMenuKeyboard(options: { admin?: boolean } = {}): Keyboard {
  const keyboard = new Keyboard();
  MENU_LAYOUT.forEach((row, index) => {
    if (index > 0) keyboard.row();
    for (const key of row) keyboard.text(t(`menu.${key}`));
  });
  if (options.admin) keyboard.row().text(t('menu.admin'));
  return keyboard.resized();
}

/** The menu button whose label is `text` in the active locale, if any. */
export function menuKeyFor(text: string): MenuKey | undefined {
  const keys: MenuKey[] = [...MENU_LAYOUT.flat(), 'admin'];
  return keys.find((key) => t(`menu.${key}`) === text);
}

export type Board = 'league' | 'global' | 'lazy';

/** Buttons to the other two boards, so each board screen leads to the rest. */
export function boardsNavKeyboard(current: Board, keyboard = new InlineKeyboard()): InlineKeyboard {
  const label: Record<Board, string> = {
    league: t('game.leagueButton'),
    global: t('game.globalButton'),
    lazy: t('game.lazyButton'),
  };
  for (const board of ['league', 'global', 'lazy'] as const) {
    if (board !== current) keyboard.text(label[board], CB[board]);
  }
  return keyboard;
}

export function channelPromptKeyboard(channel: string): InlineKeyboard {
  const handle = channel.replace(/^@/, '');
  return new InlineKeyboard()
    .url(t('channel.joinButton'), `https://t.me/${handle}`)
    .row()
    .text(t('channel.checkButton'), CB.checkMembership);
}

/** Buttons shown under a new-word card: explore, but nothing to answer. */
export function wordCardKeyboard(wordId: number, lemma: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t('card.buttons.examples'), CB.examples(wordId))
    .text(t('card.buttons.collocations'), CB.collocations(wordId))
    .row()
    .text(t('card.buttons.clips'), CB.clips(wordId))
    .url(t('card.buttons.dictionary'), dictionaryUrl(lemma));
}

/** Review card: the same exploration tools, plus the three Leitner answers. */
export function reviewCardKeyboard(wordId: number, lemma: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t('card.buttons.clips'), CB.clips(wordId))
    .url(t('card.buttons.dictionary'), dictionaryUrl(lemma))
    .row()
    .text(t('review.buttons.correct'), CB.review('c', wordId))
    .text(t('review.buttons.wrong'), CB.review('w', wordId))
    .row()
    .text(t('review.buttons.known'), CB.review('k', wordId));
}

export function dictionaryUrl(lemma: string): string {
  return `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(lemma)}`;
}

/**
 * The player under a clip: arrows that wrap around like a playlist, votes on
 * the sentence, and a link to the same moment in the full video on YouTube.
 */
export function clipKeyboard(
  deck: string,
  index: number,
  total: number,
  clip: { segmentId: number; ytVideoId: string; startMs: number },
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (total > 1) {
    keyboard
      .text(t('clips.prev'), CB.clipNav(deck, (index - 1 + total) % total))
      .text(t('clips.next'), CB.clipNav(deck, (index + 1) % total))
      .row();
  }
  const seconds = Math.floor(clip.startMs / 1000);
  return keyboard
    .text(t('clips.like'), CB.clipVote(clip.segmentId, 'l'))
    .text(t('clips.dislike'), CB.clipVote(clip.segmentId, 'd'))
    .url(t('clips.youtube'), `https://www.youtube.com/watch?v=${clip.ytVideoId}&t=${seconds}s`);
}

/** Longest search accepted: a word or a short phrase, as on YouGlish. */
const MAX_QUERY_WORDS = 6;

/** Plain English text a learner typed to search clips, not a command or a sentence in Persian. */
export function isEnglishQuery(text: string): boolean {
  const trimmed = text.trim();
  if (!/^[A-Za-z][A-Za-z'’ -]*$/.test(trimmed) || trimmed.length > 60) return false;
  return trimmed.split(/\s+/).length <= MAX_QUERY_WORDS;
}
