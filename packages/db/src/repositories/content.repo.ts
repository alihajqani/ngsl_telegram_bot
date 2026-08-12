import { and, eq, sql } from 'drizzle-orm';
import { db, type Database } from '../client.js';
import { wordCollocation, wordExample } from '../schema.js';

/**
 * Word content: contextual example sentences and collocations/idioms.
 *
 * Examples come from two sources by design. Corpus-mined ones keep their
 * `segment_id`, which is what lets an example sentence carry a "Watch this"
 * button straight to the clip it came from — something no dictionary API can
 * offer. LLM-generated ones fill the gaps for rare words.
 */

type Row<T> = T & Record<string, unknown>;

export interface ExampleCandidate {
  segmentId: number;
  text: string;
  wordCount: number;
}

export interface CorpusExampleInput {
  wordId: number;
  segmentId: number;
  text: string;
  qualityScore: number;
  ord: number;
}

export interface LlmExampleInput {
  wordId: number;
  text: string;
  ord: number;
}

export interface CollocationInput {
  wordId: number;
  phrase: string;
  meaning: string | null;
  kind: 'collocation' | 'idiom';
  ord: number;
}

/**
 * Distinct sentences containing a word, as candidates for mining.
 *
 * Deduplicated on the text itself: a stock phrase repeated across talks would
 * otherwise fill all three example slots with the same sentence.
 */
export async function findExampleCandidates(
  wordId: number,
  limit: number,
  database: Database = db(),
): Promise<ExampleCandidate[]> {
  const rows = await database.execute<Row<ExampleCandidate>>(sql`
    select distinct on (lower(s.text))
           s.id         as "segmentId",
           s.text       as "text",
           s.word_count as "wordCount"
      from word_occurrence o
      join segment s on s.id = o.segment_id
      join video   v on v.id = s.video_id
     where o.word_id = ${wordId}
       and s.active
       and v.status = 'live'
     order by lower(s.text), o.quality_score desc
     limit ${limit}
  `);
  return [...rows];
}

/** Replace a word's corpus examples. Re-mining is safe and repeatable. */
export async function saveCorpusExamples(
  wordId: number,
  examples: readonly CorpusExampleInput[],
  database: Database = db(),
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .delete(wordExample)
      .where(and(eq(wordExample.wordId, wordId), eq(wordExample.source, 'corpus')));

    if (examples.length === 0) return;
    await tx.insert(wordExample).values(
      examples.map((e) => ({
        wordId: e.wordId,
        segmentId: e.segmentId,
        text: e.text,
        source: 'corpus' as const,
        qualityScore: e.qualityScore,
        ord: e.ord,
      })),
    );
  });
}

export async function saveLlmExamples(
  wordId: number,
  examples: readonly LlmExampleInput[],
  database: Database = db(),
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .delete(wordExample)
      .where(and(eq(wordExample.wordId, wordId), eq(wordExample.source, 'llm')));

    if (examples.length === 0) return;
    await tx.insert(wordExample).values(
      examples.map((e) => ({
        wordId: e.wordId,
        text: e.text,
        source: 'llm' as const,
        qualityScore: 0,
        ord: e.ord,
      })),
    );
  });
}

export async function saveCollocations(
  wordId: number,
  collocations: readonly CollocationInput[],
  database: Database = db(),
): Promise<void> {
  if (collocations.length === 0) return;
  await database
    .insert(wordCollocation)
    .values([...collocations])
    // Unique on (word_id, phrase): a re-run refreshes meanings without duplicating.
    .onConflictDoUpdate({
      target: [wordCollocation.wordId, wordCollocation.phrase],
      set: { meaning: sql`excluded.meaning`, kind: sql`excluded.kind`, ord: sql`excluded.ord` },
    });
}

export interface WordNeedingContent {
  wordId: number;
  lemma: string;
  definition: string | null;
  have: number;
}

/**
 * Words with fewer than `min` examples, optionally restricted to one source.
 * This is what makes the LLM pass fill only genuine gaps rather than duplicating
 * work the corpus already did.
 */
export async function wordsMissingExamples(
  min: number,
  database: Database = db(),
): Promise<WordNeedingContent[]> {
  const rows = await database.execute<Row<WordNeedingContent>>(sql`
    select w.id as "wordId", w.lemma, w.definition,
           count(e.id)::int as "have"
      from word w
      left join word_example e on e.word_id = w.id
     group by w.id, w.lemma, w.definition
    having count(e.id) < ${min}
     order by w.sfi_rank
  `);
  return [...rows];
}

export async function wordsMissingCollocations(
  min: number,
  database: Database = db(),
): Promise<WordNeedingContent[]> {
  const rows = await database.execute<Row<WordNeedingContent>>(sql`
    select w.id as "wordId", w.lemma, w.definition,
           count(c.id)::int as "have"
      from word w
      left join word_collocation c on c.word_id = w.id
     group by w.id, w.lemma, w.definition
    having count(c.id) < ${min}
     order by w.sfi_rank
  `);
  return [...rows];
}

export interface ContentCoverage {
  words: number;
  withCorpusExamples: number;
  withLlmExamples: number;
  withCollocations: number;
  corpusExamples: number;
  llmExamples: number;
  collocations: number;
}

export async function contentCoverage(database: Database = db()): Promise<ContentCoverage> {
  const [row] = await database.execute<Row<ContentCoverage>>(sql`
    select
      (select count(*)::int from word) as "words",
      (select count(distinct word_id)::int from word_example where source = 'corpus') as "withCorpusExamples",
      (select count(distinct word_id)::int from word_example where source = 'llm')    as "withLlmExamples",
      (select count(distinct word_id)::int from word_collocation)                     as "withCollocations",
      (select count(*)::int from word_example where source = 'corpus')                as "corpusExamples",
      (select count(*)::int from word_example where source = 'llm')                   as "llmExamples",
      (select count(*)::int from word_collocation)                                    as "collocations"
  `);
  return row!;
}

export interface WordContent {
  examples: {
    text: string;
    source: 'corpus' | 'llm';
    /** Present only for corpus examples — the anchor for a "Watch this" button. */
    segmentId: number | null;
  }[];
  collocations: { phrase: string; meaning: string | null; kind: 'collocation' | 'idiom' }[];
}

/** Everything needed to render a word card, in two indexed reads. */
export async function getWordContent(
  wordId: number,
  database: Database = db(),
): Promise<WordContent> {
  const [examples, collocations] = await Promise.all([
    database
      .select({
        text: wordExample.text,
        source: wordExample.source,
        segmentId: wordExample.segmentId,
      })
      .from(wordExample)
      .where(eq(wordExample.wordId, wordId))
      // Corpus examples first: they are authentic and carry a watchable clip.
      .orderBy(sql`case when ${wordExample.source} = 'corpus' then 0 else 1 end`, wordExample.ord),
    database
      .select({
        phrase: wordCollocation.phrase,
        meaning: wordCollocation.meaning,
        kind: wordCollocation.kind,
      })
      .from(wordCollocation)
      .where(eq(wordCollocation.wordId, wordId))
      .orderBy(wordCollocation.ord),
  ]);

  return { examples, collocations };
}
