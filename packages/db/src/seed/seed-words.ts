import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { word } from '../schema.js';
import type { NgslRow } from './ngsl-csv.js';

/** Postgres caps bound parameters at 65535; 500 rows × 6 columns stays far clear. */
const BATCH_SIZE = 500;

export const BUCKET_COUNT = 10;

/** The transaction handle drizzle hands to the callback. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface BucketCount {
  bucket: number;
  count: number;
}

export interface SeedResult {
  rows: number;
  buckets: BucketCount[];
}

/**
 * Idempotent seed of the `word` table.
 *
 * Everything runs in one transaction so no reader can ever observe words with
 * unassigned buckets — the selector depends on all ten buckets being populated.
 */
export async function seedWords(db: Database, rows: readonly NgslRow[]): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    for (const chunk of batches(rows, BATCH_SIZE)) {
      await tx
        .insert(word)
        .values(
          chunk.map((r) => ({
            lemma: r.lemma,
            sfiRank: r.sfiRank,
            sfi: r.sfi ?? null,
            adjFreqPerMillion: r.adjFreqPerMillion ?? null,
            definition: r.definition ?? null,
            // Placeholder — overwritten by assignBuckets() before this
            // transaction commits. `bucket` is NOT NULL, so a value is required
            // here, but it is never the value that lands.
            bucket: 1,
          })),
        )
        .onConflictDoUpdate({
          target: word.lemma,
          set: {
            sfiRank: sql`excluded.sfi_rank`,
            sfi: sql`excluded.sfi`,
            adjFreqPerMillion: sql`excluded.adj_freq_per_million`,
            definition: sql`excluded.definition`,
          },
        });
    }

    await assignBuckets(tx);

    return { rows: rows.length, buckets: await bucketHistogram(tx) };
  });
}

/**
 * Assign the ten frequency buckets that make a learning batch "mixed difficulty".
 *
 * Ordering is by `sfi_rank`, not raw frequency. The NGSL's own rank is dense and
 * tie-free (1…2809), whereas `adj_freq_per_million` has large tie groups in the
 * tail — dozens of words share a frequency of 7 — which would make bucket
 * boundaries depend on arbitrary row order. v1 sorted on frequency and inherited
 * exactly that non-determinism.
 *
 * `ntile` also distributes the remainder correctly: 2,809 words over 10 buckets
 * gives nine buckets of 281 and one of 280. Bucket 1 is the most frequent
 * (easiest) end of the list.
 */
export async function assignBuckets(tx: Tx | Database): Promise<void> {
  await tx.execute(sql`
    update ${word} set bucket = ranked.bucket
    from (
      select id, ntile(${sql.raw(String(BUCKET_COUNT))}) over (order by sfi_rank) as bucket
      from ${word}
    ) as ranked
    where ${word.id} = ranked.id
      and ${word.bucket} is distinct from ranked.bucket
  `);
}

export async function bucketHistogram(tx: Tx | Database): Promise<BucketCount[]> {
  return tx
    .select({ bucket: word.bucket, count: sql<number>`count(*)::int` })
    .from(word)
    .groupBy(word.bucket)
    .orderBy(word.bucket);
}

function* batches<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
