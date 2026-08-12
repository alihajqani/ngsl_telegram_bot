import { AsyncLocalStorage } from 'node:async_hooks';
import { en } from './locales/en.js';
import { fa } from './locales/fa.js';

/**
 * Per-request localization.
 *
 * The active locale rides in `AsyncLocalStorage` rather than being threaded
 * through every function signature, so `t()` works anywhere inside a request
 * without handlers passing a locale down to formatters. Outside a request —
 * cron jobs, queue workers — callers must wrap explicitly in `runWithLocale`,
 * which is why the default is a constant rather than "whatever ran last".
 */

export type LocaleCode = 'fa' | 'en';

const CATALOGUES = { fa, en } as const;
export const DEFAULT_LOCALE: LocaleCode = 'fa';

const storage = new AsyncLocalStorage<LocaleCode>();

export function runWithLocale<T>(locale: LocaleCode, fn: () => T): T {
  return storage.run(locale, fn);
}

export function currentLocale(): LocaleCode {
  return storage.getStore() ?? DEFAULT_LOCALE;
}

/** Map a Telegram `language_code` onto a supported locale. */
export function detectLocale(languageCode: string | undefined): LocaleCode {
  return languageCode?.toLowerCase().startsWith('fa') ? 'fa' : 'en';
}

function lookup(locale: LocaleCode, key: string): unknown {
  let node: unknown = CATALOGUES[locale];
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * Translate a dot-path key.
 *
 * A missing key returns the key itself rather than throwing: a broken string is
 * a visible bug, but it should not take down a handler mid-session.
 */
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const value = lookup(currentLocale(), key) ?? lookup(DEFAULT_LOCALE, key);
  if (typeof value !== 'string') return key;
  return interpolate(value, vars);
}

/** Array accessor, for catalogues that hold lists. */
export function ta(key: string): string[] {
  const value = lookup(currentLocale(), key) ?? lookup(DEFAULT_LOCALE, key);
  return Array.isArray(value) ? (value as string[]) : [];
}

/** Escape user- or corpus-supplied text before it enters an HTML message. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
