import { getWordContent, getWordLemma } from '@ngsl/db';
import { InlineKeyboard } from 'grammy';
import { escapeHtml, t } from '../i18n/i18n.js';
import { CB } from '../keyboards.js';
import type { BotContext } from '../types.js';

/**
 * "Show examples" and "Show collocations".
 *
 * Both are a single indexed read — the content was mined and generated offline
 * in Phase 6 precisely so these buttons never wait on a corpus scan or an LLM.
 */

function parseWordId(data: string | undefined, prefix: string): number | undefined {
  const match = new RegExp(`^${prefix}:(\\d+)$`).exec(data ?? '');
  return match ? Number(match[1]) : undefined;
}

export async function examplesHandler(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const wordId = parseWordId(ctx.callbackQuery?.data, 'ex');
  if (wordId === undefined) return;

  const [content, lemma] = await Promise.all([getWordContent(wordId), getWordLemma(wordId)]);
  const safeLemma = escapeHtml(lemma ?? '');

  if (content.examples.length === 0) {
    await ctx.reply(t('content.noExamples'), { parse_mode: 'HTML' });
    return;
  }

  const lines = [t('content.examplesHeader', { lemma: safeLemma }), ''];
  for (const [index, example] of content.examples.entries()) {
    lines.push(`${index + 1}. ${escapeHtml(example.text)}`);
  }

  // Corpus-mined examples keep their segment_id, so at least one of them came
  // from a real clip — offer to watch it. That link is the whole reason to mine
  // the corpus rather than call a dictionary API.
  const watchable = content.examples.some((e) => e.segmentId !== null);
  const keyboard = watchable
    ? new InlineKeyboard().text(t('content.watchButton'), CB.clips(wordId))
    : undefined;

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
}

export async function collocationsHandler(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const wordId = parseWordId(ctx.callbackQuery?.data, 'co');
  if (wordId === undefined) return;

  const [content, lemma] = await Promise.all([getWordContent(wordId), getWordLemma(wordId)]);

  if (content.collocations.length === 0) {
    await ctx.reply(t('content.noCollocations'), { parse_mode: 'HTML' });
    return;
  }

  const lines = [t('content.collocationsHeader', { lemma: escapeHtml(lemma ?? '') }), ''];
  for (const item of content.collocations) {
    const tag = item.kind === 'idiom' ? `${t('content.idiomTag')} ` : '• ';
    const meaning = item.meaning ? ` — <i>${escapeHtml(item.meaning)}</i>` : '';
    lines.push(`${tag}<b>${escapeHtml(item.phrase)}</b>${meaning}`);
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}
