import {
  db,
  findExampleCandidates,
  saveCorpusExamples,
  type Database,
} from '@ngsl/db';
import { word } from '@ngsl/db/schema';
import { Lexicon } from '@ngsl/media';
import { createLogger } from '@ngsl/shared';
import { scoreReadability, type ReadabilityContext } from './readability.js';

const log = createLogger('content.mine');

/** How many candidate sentences to score per word before taking the best. */
const CANDIDATE_POOL = 60;

export interface MineOptions {
  /** Examples to keep per word. */
  perWord?: number;
  /** Below this readability score a sentence is not worth showing. */
  minScore?: number;
}

export interface MineStats {
  wordsProcessed: number;
  wordsWithExamples: number;
  examplesSaved: number;
}

/** Load the lexicon and bucket map once — 2,809 rows, negligible memory. */
export async function loadReadabilityContext(
  database: Database = db(),
): Promise<ReadabilityContext> {
  const rows = await database
    .select({ id: word.id, lemma: word.lemma, bucket: word.bucket })
    .from(word);

  if (rows.length === 0) {
    throw new Error('The word table is empty — run `pnpm db:seed` first.');
  }

  return {
    lexicon: new Lexicon(rows),
    buckets: new Map(rows.map((r) => [r.id, r.bucket])),
  };
}

/**
 * Mine the best authentic example sentences for one word.
 *
 * Every kept example retains its `segment_id`, so the card can offer a "Watch
 * this" button that jumps to the exact moment the sentence was spoken. That
 * link is the whole reason to prefer corpus mining over a dictionary API.
 */
export async function mineWord(
  wordId: number,
  context: ReadabilityContext,
  options: MineOptions = {},
  database: Database = db(),
): Promise<number> {
  const { perWord = 3, minScore = 0.5 } = options;

  const candidates = await findExampleCandidates(wordId, CANDIDATE_POOL, database);
  if (candidates.length === 0) return 0;

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      ...scoreReadability(candidate.text, wordId, context),
    }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, perWord);

  await saveCorpusExamples(
    wordId,
    ranked.map((r, index) => ({
      wordId,
      segmentId: r.candidate.segmentId,
      text: r.candidate.text,
      qualityScore: r.score,
      ord: index,
    })),
    database,
  );

  return ranked.length;
}

export async function mineAll(
  options: MineOptions = {},
  database: Database = db(),
): Promise<MineStats> {
  const context = await loadReadabilityContext(database);
  const words = await database.select({ id: word.id }).from(word).orderBy(word.sfiRank);

  const stats: MineStats = { wordsProcessed: 0, wordsWithExamples: 0, examplesSaved: 0 };

  for (const { id } of words) {
    const saved = await mineWord(id, context, options, database);
    stats.wordsProcessed += 1;
    if (saved > 0) stats.wordsWithExamples += 1;
    stats.examplesSaved += saved;

    if (stats.wordsProcessed % 250 === 0) {
      log.info('Mining progress', { ...stats });
    }
  }

  log.info('Corpus mining complete', { ...stats });
  return stats;
}
