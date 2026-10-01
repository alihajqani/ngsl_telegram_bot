import {
  db,
  PARTS_OF_SPEECH,
  saveCollocations,
  saveLlmExamples,
  saveWordDetail,
  wordsMissingCollocations,
  wordsMissingDetails,
  wordsMissingExamples,
  type Database,
  type PartOfSpeech,
  type WordNeedingContent,
} from '@ngsl/db';
import { AllKeysExhaustedError, completeJson, type ChatMessage } from '@ngsl/llm';
import { createLogger } from '@ngsl/shared';
import { z } from 'zod';

const log = createLogger('content.generate');

/**
 * Offline content generation.
 *
 * Runs once, in batch, on your own GPU — not per request. A word card must
 * render from a single indexed SELECT, so nothing here is on the hot path: the
 * bot keeps working when the LLM is down, and cost does not scale with users.
 *
 * Words are batched per request because 2,809 individual calls is an order of
 * magnitude more time and money than 350 batched ones, for the same output.
 */

const BATCH_SIZE = 8;

/**
 * The model is asked for `{"words": [...]}` but now and then answers with the
 * bare array. Same data, so it is accepted rather than costing the batch.
 */
const wrapBareArray = (value: unknown): unknown => (Array.isArray(value) ? { words: value } : value);

export const exampleBatchSchema = z.preprocess(
  wrapBareArray,
  z.object({
    words: z.array(
      z.object({
        word: z.string().min(1),
        examples: z.array(z.string().min(1)).min(1).max(4),
      }),
    ),
  }),
);

type CollocationKind = 'collocation' | 'idiom';

/**
 * Coerce the model's `kind` rather than validating it.
 *
 * This one field must never cost us a whole batch. The model periodically
 * copies the shape example instead of choosing a value — an observed
 * `"kind": "..."` failed the enum and discarded all eight words' phrases, not
 * merely the offending field. Anything unrecognised becomes undefined, which
 * the caller already falls back to 'collocation' for.
 */
const asCollocationKind = (value: unknown): CollocationKind | undefined =>
  value === 'collocation' || value === 'idiom' ? value : undefined;

export const collocationBatchSchema = z.preprocess(
  wrapBareArray,
  z.object({
    words: z.array(
      z.object({
        word: z.string().min(1),
        phrases: z
          .array(
            z.object({
              phrase: z.string().min(1).max(160),
              meaning: z.string().min(1).max(400),
              // Coerced, not validated — see asCollocationKind.
              kind: z.unknown().transform(asCollocationKind),
            }),
          )
          .min(1)
          .max(8),
      }),
    ),
  }),
);

/** Names the model uses for a part of speech the card already has a label for. */
const POS_ALIASES: Record<string, PartOfSpeech> = {
  article: 'determiner',
  'auxiliary verb': 'verb',
  auxiliary: 'verb',
  'modal verb': 'modal',
  numeral: 'number',
  adj: 'adjective',
  adv: 'adverb',
  prep: 'preposition',
  conj: 'conjunction',
};

/**
 * Without the aliases, "the" answered as an article would match nothing and be
 * asked for again on every run.
 */
const asPartOfSpeech = (value: unknown): PartOfSpeech | undefined => {
  const pos = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if ((PARTS_OF_SPEECH as readonly string[]).includes(pos)) return pos as PartOfSpeech;
  return POS_ALIASES[pos];
};

/** A single English word, as a family member or synonym must be. */
const isWord = (value: string): boolean => /^[a-z][a-z'-]*$/.test(value);

/** A list that may arrive as a bare value, or not at all. */
const looseList = z.preprocess((value): unknown[] => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? (value as unknown[]) : [value];
}, z.array(z.unknown()));

/** One `{word, ...}` item of a list, or undefined for anything else. */
const asItem = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && typeof (value as { word?: unknown }).word === 'string'
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Lenient like the collocation schema: an unknown part of speech or a stray
 * item drops that one item, never the batch. Each word's lists are checked in
 * `cleanDetail`.
 */
export const detailBatchSchema = z.preprocess(
  wrapBareArray,
  z.object({
    words: z.array(
      z.object({
        word: z.string().min(1),
        pos: looseList,
        family: looseList,
        base: z.unknown(),
        synonyms: looseList,
      }),
    ),
  }),
);
type DetailEntry = z.infer<typeof detailBatchSchema>['words'][number];

const MAX_FAMILY = 5;
const MAX_SYNONYMS = 3;

/**
 * Half the usual batch. An entry here is several times a collocation list, and
 * on the server eight of them took gemma-4 past the 180 s request timeout on
 * every batch; four take 70–100 s.
 */
const DETAIL_BATCH_SIZE = 4;

const lower = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

/**
 * Keep only what can be shown as-is: known parts of speech, single real-looking
 * words, nothing that repeats the headword. Undefined when no part of speech
 * survives, so the word is retried by the next run instead of saved blank.
 */
export function cleanDetail(lemma: string, entry: DetailEntry) {
  const headword = lemma.toLowerCase();
  const partsOfSpeech = [
    ...new Set(entry.pos.map(asPartOfSpeech).filter((p) => p !== undefined)),
  ];
  if (partsOfSpeech.length === 0) return undefined;

  const base = lower(entry.base);
  const baseWord = isWord(base) && base !== headword ? base : null;

  // The base word has its own line on the card; listed in the family too, it
  // showed twice ("government": govern, and "formed from: govern").
  const seen = new Set([headword, ...(baseWord ? [baseWord] : [])]);
  const family: { word: string; pos: PartOfSpeech }[] = [];
  for (const item of entry.family.map(asItem)) {
    const word = lower(item?.word);
    const pos = asPartOfSpeech(item?.pos);
    if (!pos || !isWord(word) || seen.has(word)) continue;
    seen.add(word);
    family.push({ word, pos });
  }

  const synonyms: { word: string; note: string | null }[] = [];
  for (const item of entry.synonyms.map(asItem)) {
    const word = lower(item?.word);
    if (!isWord(word) || word === headword || synonyms.some((s) => s.word === word)) continue;
    const note = typeof item?.note === 'string' ? item.note.trim() : '';
    synonyms.push({ word, note: note || null });
  }

  return {
    partsOfSpeech,
    family: family.slice(0, MAX_FAMILY),
    baseWord,
    synonyms: synonyms.slice(0, MAX_SYNONYMS),
  };
}

export interface GenerateOptions {
  /** Cap the run — useful for a smoke test before committing the GPU overnight. */
  limit?: number;
  batchSize?: number;
  /**
   * Epoch ms after which no new batch starts; the one in flight still finishes.
   * A scheduled run ends on time this way and leaves the rest to the next one.
   */
  deadline?: number;
}

export interface GenerateStats {
  wordsConsidered: number;
  wordsWritten: number;
  itemsWritten: number;
  batchesFailed: number;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A batch that parses but writes nothing is a failure in disguise: the model
 * answered for words it was not asked about, or with placeholders. Left
 * silent, that once made a whole run report "0 failed" while saving nothing.
 */
function warnIfNothingMatched(
  kind: string,
  batch: readonly WordNeedingContent[],
  returned: readonly { word: string }[],
  written: number,
): void {
  if (written > 0) return;
  log.warn(`${kind} batch matched no requested word`, {
    requested: batch.map((w) => w.lemma),
    returned: returned.map((w) => w.word).slice(0, 10),
  });
}

/**
 * Run `work` over the targets batch by batch, counting the failures.
 *
 * One bad batch must not abandon the remaining 2,000 words. Every API key
 * being rate limited is the exception: each later batch would fail the same
 * way, and each failure is a warning mirrored to the monitor topic.
 */
async function forEachBatch(
  kind: string,
  targets: readonly WordNeedingContent[],
  options: GenerateOptions,
  stats: GenerateStats,
  work: (batch: WordNeedingContent[]) => Promise<void>,
): Promise<void> {
  const { batchSize = BATCH_SIZE, deadline } = options;

  for (const batch of chunk(targets, batchSize)) {
    if (deadline !== undefined && Date.now() >= deadline) {
      log.info(`${kind} generation paused at its deadline`, { ...stats });
      return;
    }

    try {
      await work(batch);
    } catch (error) {
      stats.batchesFailed += 1;
      if (error instanceof AllKeysExhaustedError) {
        log.warn(`${kind} generation stopped: every API key is rate limited`, { ...stats });
        return;
      }
      log.warn(`${kind} batch failed`, { words: batch.map((w) => w.lemma), error });
    }

    log.info(`${kind} generation progress`, { ...stats });
  }
}

const listFor = (words: readonly WordNeedingContent[]): string =>
  words.map((w) => `- ${w.lemma}${w.definition ? ` (${w.definition})` : ''}`).join('\n');

/**
 * Fill example gaps for words the corpus could not cover.
 *
 * The instruction to stay inside high-frequency vocabulary matters: an example
 * that needs three rarer words to understand teaches nothing, which is the same
 * criterion the corpus miner scores for.
 */
export async function generateExamples(
  options: GenerateOptions = {},
  database: Database = db(),
): Promise<GenerateStats> {
  const { limit } = options;

  const missing = await wordsMissingExamples(2, database);
  const targets = limit ? missing.slice(0, limit) : missing;
  const stats: GenerateStats = {
    wordsConsidered: targets.length,
    wordsWritten: 0,
    itemsWritten: 0,
    batchesFailed: 0,
  };

  await forEachBatch('Example', targets, options, stats, async (batch) => {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You write example sentences for English vocabulary learners. ' +
          'Reply with JSON only — no prose, no markdown.',
      },
      {
        role: 'user',
        content:
          `Write 3 example sentences for each word below.\n\n${listFor(batch)}\n\n` +
          'Rules:\n' +
          '- Each sentence must contain the target word (any inflection is fine).\n' +
          '- 6 to 18 words long, a complete standalone sentence with a full stop.\n' +
          '- Use only common, high-frequency English elsewhere in the sentence, so a ' +
          'learner who does not know the target word can still read the rest.\n' +
          '- Make the surrounding context reveal the meaning.\n' +
          '- Vary the situations; do not reuse one template.\n\n' +
          'JSON shape: {"words":[{"word":"...","examples":["...","...","..."]}]}',
      },
    ];

    const result = await completeJson(messages, exampleBatchSchema, { temperature: 0.7 });
    const byLemma = new Map(batch.map((w) => [w.lemma.toLowerCase(), w]));
    const writtenBefore = stats.wordsWritten;

    for (const entry of result.words) {
      const target = byLemma.get(entry.word.toLowerCase().trim());
      if (!target) continue;

      // Trust but verify: drop any sentence that does not contain its word.
      const usable = entry.examples
        .map((text) => text.trim())
        .filter((text) => text.toLowerCase().includes(target.lemma.slice(0, 4).toLowerCase()))
        .slice(0, 3);
      if (usable.length === 0) continue;

      await saveLlmExamples(
        target.wordId,
        usable.map((text, ord) => ({ wordId: target.wordId, text, ord })),
        database,
      );
      stats.wordsWritten += 1;
      stats.itemsWritten += usable.length;
    }
    warnIfNothingMatched('Example', batch, result.words, stats.wordsWritten - writtenBefore);
  });

  return stats;
}

/**
 * Collocations and idioms for every word — the on-demand button's data source.
 *
 * Pure LLM work: this is exactly the knowledge a corpus of 5,000 talks cannot
 * reliably supply, because a collocation list is a lexicographic judgement
 * rather than something you can count out of transcripts.
 */
export async function generateCollocations(
  options: GenerateOptions = {},
  database: Database = db(),
): Promise<GenerateStats> {
  const { limit } = options;

  const missing = await wordsMissingCollocations(4, database);
  const targets = limit ? missing.slice(0, limit) : missing;
  const stats: GenerateStats = {
    wordsConsidered: targets.length,
    wordsWritten: 0,
    itemsWritten: 0,
    batchesFailed: 0,
  };

  await forEachBatch('Collocation', targets, options, stats, async (batch) => {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a lexicographer producing collocation lists for English learners. ' +
          'Reply with JSON only — no prose, no markdown.',
      },
      {
        role: 'user',
        content:
          `For each word below, give the 5 most useful collocations or idioms.\n\n${listFor(batch)}\n\n` +
          'Rules:\n' +
          '- Only genuinely common combinations a native speaker actually uses.\n' +
          '- Each entry must contain the target word.\n' +
          '- "meaning" is a short plain-English gloss, under 15 words.\n' +
          '- Mark "idiom" when the meaning is not deducible from the parts, otherwise "collocation".\n' +
          '- Prefer variety: verb+noun, adjective+noun, preposition patterns.\n\n' +
          '- "kind" must be exactly "collocation" or "idiom".\n\n' +
          // A worked example rather than "..." placeholders: the model copied
          // those literally, emitting `"kind": "..."` and failing validation.
          'Example of the exact JSON shape:\n' +
          '{"words":[{"word":"break","phrases":[' +
          '{"phrase":"break a habit","meaning":"stop doing something regular","kind":"collocation"},' +
          '{"phrase":"break the ice","meaning":"ease initial awkwardness","kind":"idiom"}]}]}',
      },
    ];

    const result = await completeJson(messages, collocationBatchSchema, { temperature: 0.5 });
    const byLemma = new Map(batch.map((w) => [w.lemma.toLowerCase(), w]));
    const writtenBefore = stats.wordsWritten;

    for (const entry of result.words) {
      const target = byLemma.get(entry.word.toLowerCase().trim());
      if (!target) continue;

      const phrases = entry.phrases.slice(0, 5);
      if (phrases.length === 0) continue;

      await saveCollocations(
        target.wordId,
        phrases.map((p, ord) => ({
          wordId: target.wordId,
          phrase: p.phrase.trim(),
          meaning: p.meaning.trim(),
          kind: p.kind ?? 'collocation',
          ord,
        })),
        database,
      );
      stats.wordsWritten += 1;
      stats.itemsWritten += phrases.length;
    }
    warnIfNothingMatched('Collocation', batch, result.words, stats.wordsWritten - writtenBefore);
  });

  return stats;
}

/**
 * Grammar details for every word: parts of speech, word family, base word and
 * synonyms, shown on the new-word card. Asked for by a teacher using the bot:
 * a learner who meets "decisive" should see "decide" and "decision" with it.
 */
export async function generateWordDetails(
  options: GenerateOptions = {},
  database: Database = db(),
): Promise<GenerateStats> {
  const { limit } = options;

  const missing = await wordsMissingDetails(database);
  const targets = limit ? missing.slice(0, limit) : missing;
  const stats: GenerateStats = {
    wordsConsidered: targets.length,
    wordsWritten: 0,
    itemsWritten: 0,
    batchesFailed: 0,
  };

  const batchOptions = { ...options, batchSize: options.batchSize ?? DETAIL_BATCH_SIZE };
  await forEachBatch('Detail', targets, batchOptions, stats, async (batch) => {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          "You are a lexicographer writing learner's dictionary entries for learners of " +
          'English. Reply with JSON only — no prose, no markdown.',
      },
      {
        role: 'user',
        content:
          `Give the grammar facts for each word below.\n\n${listFor(batch)}\n\n` +
          'Rules:\n' +
          '- "pos": every part of speech the word commonly has, most common first, each one ' +
          `of: ${PARTS_OF_SPEECH.join(', ')}.\n` +
          '- "family": up to 5 other common words built from the same root with a prefix or ' +
          'suffix (decide: decision, decisive, decisively), each with its part of speech. ' +
          'Not words only related in meaning (have: possession), not the word itself, and ' +
          'not its plain inflections (decides, decided, cars). An empty list when there are ' +
          'none.\n' +
          '- "base": the word it is formed from when it is a derived word ' +
          '(government → govern, happiness → happy); null when it is a base word.\n' +
          '- "synonyms": up to 3 common single-word synonyms a learner could use instead in ' +
          'everyday contexts, each with a "note" under 10 words on how it differs. An empty ' +
          'list when there is no close synonym, as for "the" or "and".\n\n' +
          'Example of the exact JSON shape:\n' +
          '{"words":[{"word":"decide","pos":["verb"],' +
          '"family":[{"word":"decision","pos":"noun"},{"word":"decisive","pos":"adjective"},' +
          '{"word":"decisively","pos":"adverb"}],"base":null,' +
          '"synonyms":[{"word":"choose","note":"pick between options; more everyday"},' +
          '{"word":"determine","note":"more formal"}]}]}',
      },
    ];

    const result = await completeJson(messages, detailBatchSchema, { temperature: 0.3 });
    const byLemma = new Map(batch.map((w) => [w.lemma.toLowerCase(), w]));
    const writtenBefore = stats.wordsWritten;

    for (const entry of result.words) {
      const target = byLemma.get(entry.word.toLowerCase().trim());
      if (!target) continue;

      const detail = cleanDetail(target.lemma, entry);
      if (!detail) continue;

      await saveWordDetail({ wordId: target.wordId, ...detail }, database);
      stats.wordsWritten += 1;
      stats.itemsWritten += detail.family.length + detail.synonyms.length;
    }
    warnIfNothingMatched('Detail', batch, result.words, stats.wordsWritten - writtenBefore);
  });

  return stats;
}
