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
} as const;

export const CB_PATTERN = {
  examples: /^ex:(\d+)$/,
  collocations: /^co:(\d+)$/,
  clips: /^cl:(\d+)$/,
  review: /^rv:([cwk]):(\d+)$/,
} as const;

export function mainMenuKeyboard(): Keyboard {
  return new Keyboard()
    .text(t('menu.newWords'))
    .text(t('menu.review'))
    .row()
    .text(t('menu.writing'))
    .text(t('menu.streak'))
    .row()
    .text(t('menu.progress'))
    .text(t('menu.settings'))
    .resized()
    .persistent();
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
