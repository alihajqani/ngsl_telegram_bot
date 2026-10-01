import type { NewWordCard, ReviewCard, WordGrammar } from '@ngsl/db';
import { escapeHtml, t } from '../i18n/i18n.js';

/**
 * Card rendering, kept out of the handlers.
 *
 * Every dynamic value passes through `escapeHtml` first: definitions and
 * subtitle sentences come from the NGSL file and from YouTube captions, neither
 * of which is guaranteed free of `<`, `>` or `&`. One unescaped ampersand is a
 * Telegram 400 that breaks the whole card.
 */

export function buildWordCard(word: NewWordCard): string {
  const headword = t('card.word', { lemma: escapeHtml(word.lemma) });
  const pos = word.grammar?.partsOfSpeech.map((p) => t(`card.pos.${p}`)).join(' / ');
  const lines = [pos ? `${headword}  ${t('card.partsOfSpeech', { pos })}` : headword];
  if (word.definition) {
    lines.push(t('card.definition', { definition: escapeHtml(word.definition) }));
  }
  if (word.grammar) lines.push(...grammarLines(word.grammar));
  return lines.join('\n');
}

/**
 * Word family, base word and synonyms, under the definition. Each synonym gets
 * its own line: its English note inside a Persian line would come out of
 * Telegram's bidi reordering scrambled.
 */
function grammarLines(grammar: WordGrammar): string[] {
  const lines: string[] = [];
  if (grammar.family.length > 0) {
    const words = grammar.family
      .map((m) => `${escapeHtml(m.word)} (${t(`card.pos.${m.pos}`)})`)
      .join(' · ');
    lines.push(t('card.family', { words }));
  }
  if (grammar.baseWord) lines.push(t('card.baseWord', { word: escapeHtml(grammar.baseWord) }));
  if (grammar.synonyms.length > 0) {
    lines.push(t('card.synonyms'));
    for (const synonym of grammar.synonyms) {
      const note = synonym.note ? `: <i>${escapeHtml(synonym.note)}</i>` : '';
      lines.push(`• <b>${escapeHtml(synonym.word)}</b>${note}`);
    }
  }
  return lines.length > 0 ? ['', ...lines] : [];
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
