import {
  db,
  saveCollocations,
  saveLlmExamples,
  wordsMissingCollocations,
  wordsMissingExamples,
  type Database,
  type WordNeedingContent,
} from '@ngsl/db';
import { completeJson, type ChatMessage } from '@ngsl/llm';
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

const exampleBatchSchema = z.object({
  words: z.array(
    z.object({
      word: z.string().min(1),
      examples: z.array(z.string().min(1)).min(1).max(4),
    }),
  ),
});

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

const collocationBatchSchema = z.object({
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
});

export interface GenerateOptions {
  /** Cap the run — useful for a smoke test before committing the GPU overnight. */
  limit?: number;
  batchSize?: number;
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
  const { limit, batchSize = BATCH_SIZE } = options;

  const missing = await wordsMissingExamples(2, database);
  const targets = limit ? missing.slice(0, limit) : missing;
  const stats: GenerateStats = {
    wordsConsidered: targets.length,
    wordsWritten: 0,
    itemsWritten: 0,
    batchesFailed: 0,
  };

  for (const batch of chunk(targets, batchSize)) {
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

    try {
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
    } catch (error) {
      // One bad batch must not abandon the remaining 2,000 words.
      stats.batchesFailed += 1;
      log.warn('Example batch failed', { words: batch.map((w) => w.lemma), error });
    }

    log.info('Example generation progress', { ...stats });
  }

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
  const { limit, batchSize = BATCH_SIZE } = options;

  const missing = await wordsMissingCollocations(4, database);
  const targets = limit ? missing.slice(0, limit) : missing;
  const stats: GenerateStats = {
    wordsConsidered: targets.length,
    wordsWritten: 0,
    itemsWritten: 0,
    batchesFailed: 0,
  };

  for (const batch of chunk(targets, batchSize)) {
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

    try {
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
    } catch (error) {
      stats.batchesFailed += 1;
      log.warn('Collocation batch failed', { words: batch.map((w) => w.lemma), error });
    }

    log.info('Collocation generation progress', { ...stats });
  }

  return stats;
}
