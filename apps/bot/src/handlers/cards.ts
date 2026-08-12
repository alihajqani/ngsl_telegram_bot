import type { ReviewCard, WordCard } from '@ngsl/db';
import { escapeHtml, t } from '../i18n/i18n.js';

/**
 * Card rendering, kept out of the handlers.
 *
 * Every dynamic value passes through `escapeHtml` first: definitions and
 * subtitle sentences come from the NGSL file and from YouTube captions, neither
 * of which is guaranteed free of `<`, `>` or `&`. One unescaped ampersand is a
 * Telegram 400 that breaks the whole card.
 */

export function buildWordCard(word: WordCard): string {
  const lines = [t('card.word', { lemma: escapeHtml(word.lemma) })];
  if (word.definition) {
    lines.push(t('card.definition', { definition: escapeHtml(word.definition) }));
  }
  return lines.join('\n');
}

export function buildReviewCard(word: ReviewCard, remaining: number): string {
  const lines = [
    t('card.word', { lemma: escapeHtml(word.lemma) }),
    '',
    [
      t('card.box', { box: word.box }),
      word.reviewCount === 0
        ? t('card.firstTime')
        : t('card.reviewCount', { count: word.reviewCount }),
    ].join('  ·  '),
    '',
    t('review.prompt'),
  ];
  if (remaining > 0) lines.push(t('card.remaining', { count: remaining }));
  return lines.join('\n');
}

const DAY_MS = 86_400_000;

export function buildAnswerFeedback(
  result: 'correct' | 'wrong' | 'known',
  lemma: string,
  boxAfter: number,
  nextReviewAt: Date,
  now: Date = new Date(),
): string {
  const safe = escapeHtml(lemma);
  const headline =
    result === 'correct'
      ? t('review.correct', { lemma: safe, box: boxAfter })
      : result === 'wrong'
        ? t('review.wrong', { lemma: safe })
        : t('review.known', { lemma: safe });

  const days = Math.max(1, Math.round((nextReviewAt.getTime() - now.getTime()) / DAY_MS));
  return `${headline}\n<i>${t('review.nextDue', { days })}</i>`;
}
