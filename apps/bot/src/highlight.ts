import { escapeHtml } from './i18n/i18n.js';

/**
 * Bold the target word inside a clip's caption, YouGlish-style.
 *
 * The forms come from ingest ("went" for go, "don't" for do), so this only has
 * to find those tokens: no lemmatizer in the bot. Tokens are compared
 * lowercased with straight apostrophes, the way the forms were stored.
 */
const TOKEN = /[A-Za-z][A-Za-z'’‘ʼ]*/g;

const normalize = (token: string): string => token.toLowerCase().replace(/[’‘ʼ]/g, "'");

export function highlightForms(sentence: string, forms: readonly string[]): string {
  if (forms.length === 0) return escapeHtml(sentence);
  const wanted = new Set(forms);

  let html = '';
  let cursor = 0;
  for (const match of sentence.matchAll(TOKEN)) {
    const token = match[0];
    if (!wanted.has(normalize(token))) continue;
    html += `${escapeHtml(sentence.slice(cursor, match.index))}<b>${escapeHtml(token)}</b>`;
    cursor = match.index + token.length;
  }
  return html + escapeHtml(sentence.slice(cursor));
}

/** Search results arrive from Postgres with hits wrapped in \u0001…\u0002. */
export function highlightMarked(marked: string): string {
  return escapeHtml(marked).replaceAll('\u0001', '<b>').replaceAll('\u0002', '</b>');
}
