import {
  applyReview,
  initialState,
  isBox,
  type Box,
  type ReviewResult,
} from '@ngsl/core';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { db, type Database } from '../client.js';
import { reviewEvent, userSettings, userWord, word } from '../schema.js';

/**
 * The learning engine's persistence layer.
 *
 * All Leitner arithmetic lives in `@ngsl/core` and is unit-tested there; this
 * module only reads state, calls those pure functions, and writes the result.
 * v1 kept two parallel implementations — dead document methods plus the real
 * atomic update — and they were free to drift.
 */

type Row<T> = T & Record<string, unknown>;

export interface WordCard {
  wordId: number;
  lemma: string;
  definition: string | null;
  bucket: number;
}

export interface ReviewCard extends WordCard {
  box: Box;
  reviewCount: number;
}

export interface DailyLimits {
  newTarget: number;
  reviewTarget: number;
  newDoneToday: number;
  reviewDoneToday: number;
  timezone: string;
}

/** Local midnight in the user's zone, as a SQL expression. */
const startOfLocalDay = (timezone: string) =>
  sql`date_trunc('day', now() at time zone ${timezone}) at time zone ${timezone}`;

export async function getDailyLimits(
  userId: number,
  database: Database = db(),
): Promise<DailyLimits> {
  const settings = await database.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });

  // Defaults mirror the column defaults, so a user with no settings row still works.
  const newTarget = settings?.dailyNewTarget ?? 5;
  const reviewTarget = settings?.dailyReviewTarget ?? 10;
  const timezone = settings?.timezone ?? 'Asia/Tehran';

  const [counts] = await database.execute<Row<{ newDone: number; reviewDone: number }>>(sql`
    select
      (select count(*)::int from ${userWord}
        where user_id = ${userId} and first_seen_at >= ${startOfLocalDay(timezone)}) as "newDone",
      (select count(*)::int from ${reviewEvent}
        where user_id = ${userId} and created_at >= ${startOfLocalDay(timezone)}) as "reviewDone"
  `);

  return {
    newTarget,
    reviewTarget,
    timezone,
    newDoneToday: counts?.newDone ?? 0,
    reviewDoneToday: counts?.reviewDone ?? 0,
  };
}

/**
 * Pick new words for a session.
 *
 * Two guarantees, both enforced in SQL rather than by scanning 2,809 rows in
 * memory the way v1 did:
 *
 *  - **Mixed difficulty.** Candidates are drawn per frequency bucket via
 *    `row_number() partition by bucket`, so a batch spans easy and hard words
 *    instead of clustering wherever `random()` happened to land.
 *  - **Clip readiness.** Within a bucket, words that already have a rendered
 *    clip sort first, so the learner rarely waits on a render.
 *
 * Returns at most `limit` words, already shuffled.
 */
export async function selectNewWords(
  userId: number,
  limit: number,
  database: Database = db(),
): Promise<WordCard[]> {
  if (limit <= 0) return [];

  // Spread the request across all ten buckets, rounding up so small limits
  // still reach every bucket.
  const perBucket = Math.max(1, Math.ceil(limit / 10));

  const rows = await database.execute<Row<WordCard>>(sql`
    select "wordId", lemma, definition, bucket
      from (
        select w.id as "wordId",
               w.lemma,
               w.definition,
               w.bucket,
               row_number() over (
                 partition by w.bucket
                 order by (
                   exists (
                     select 1 from word_occurrence o
                       join segment_media m on m.segment_id = o.segment_id
                      where o.word_id = w.id
                        and not m.disabled
                   )
                 ) desc, random()
               ) as rn
          from ${word} w
         where not exists (
           select 1 from ${userWord} uw
            where uw.user_id = ${userId} and uw.word_id = w.id
         )
      ) ranked
     where rn <= ${perBucket}
     order by rn, random()
     limit ${limit}
  `);

  return [...rows].map((r) => ({
    wordId: r.wordId,
    lemma: r.lemma,
    definition: r.definition,
    bucket: r.bucket,
  }));
}

/**
 * Introduce words at box 1, due tomorrow. Idempotent if a word is re-issued.
 * Returns how many were new to the deck, so a re-issued word earns nothing.
 */
export async function addNewWords(
  userId: number,
  wordIds: readonly number[],
  now: Date = new Date(),
  database: Database = db(),
): Promise<number> {
  if (wordIds.length === 0) return 0;
  const state = initialState(now);

  const inserted = await database
    .insert(userWord)
    .values(
      wordIds.map((wordId) => ({
        userId,
        wordId,
        box: state.box,
        reviewCount: 0,
        nextReviewAt: state.nextReviewAt,
      })),
    )
    .onConflictDoNothing()
    .returning({ wordId: userWord.wordId });
  return inserted.length;
}

/** One word's card. New words are shown one at a time, so each is read when its turn comes. */
export async function getWordCard(
  wordId: number,
  database: Database = db(),
): Promise<WordCard | undefined> {
  const [row] = await database
    .select({ wordId: word.id, lemma: word.lemma, definition: word.definition, bucket: word.bucket })
    .from(word)
    .where(eq(word.id, wordId));
  return row;
}

/** Words due for review, most overdue first. */
export async function getDueWords(
  userId: number,
  limit: number,
  now: Date = new Date(),
  database: Database = db(),
): Promise<ReviewCard[]> {
  if (limit <= 0) return [];

  const rows = await database
    .select({
      wordId: word.id,
      lemma: word.lemma,
      definition: word.definition,
      bucket: word.bucket,
      box: userWord.box,
      reviewCount: userWord.reviewCount,
    })
    .from(userWord)
    .innerJoin(word, eq(word.id, userWord.wordId))
    .where(and(eq(userWord.userId, userId), lte(userWord.nextReviewAt, now)))
    .orderBy(asc(userWord.nextReviewAt))
    .limit(limit);

  return rows.map((r) => ({ ...r, box: isBox(r.box) ? r.box : 1 }));
}

export interface ReviewOutcome {
  boxBefore: Box;
  boxAfter: Box;
  nextReviewAt: Date;
  reviewCount: number;
}

/**
 * Record a review answer.
 *
 *   correct → up one box (capped at 5)
 *   wrong   → back to box 1
 *   known   → straight to box 5, the "I know this" jump
 *
 * The row is locked for the duration so two rapid taps cannot interleave into a
 * lost update, and the append-only `review_event` is written in the same
 * transaction — it is what daily caps, streaks and analytics all read.
 */
export async function recordReview(
  userId: number,
  wordId: number,
  result: ReviewResult,
  now: Date = new Date(),
  database: Database = db(),
): Promise<ReviewOutcome | undefined> {
  return database.transaction(async (tx) => {
    const [current] = await tx
      .select({
        box: userWord.box,
        reviewCount: userWord.reviewCount,
        nextReviewAt: userWord.nextReviewAt,
        lastReviewedAt: userWord.lastReviewedAt,
      })
      .from(userWord)
      .where(and(eq(userWord.userId, userId), eq(userWord.wordId, wordId)))
      .for('update');

    // The word is not in this user's deck — a stale callback button, not an error.
    if (!current) return undefined;

    const boxBefore: Box = isBox(current.box) ? current.box : 1;
    const next = applyReview(
      {
        box: boxBefore,
        reviewCount: current.reviewCount,
        nextReviewAt: current.nextReviewAt,
        lastReviewedAt: current.lastReviewedAt,
      },
      result,
      now,
    );

    await tx
      .update(userWord)
      .set({
        box: next.box,
        reviewCount: next.reviewCount,
        nextReviewAt: next.nextReviewAt,
        lastReviewedAt: now,
      })
      .where(and(eq(userWord.userId, userId), eq(userWord.wordId, wordId)));

    await tx.insert(reviewEvent).values({
      userId,
      wordId,
      result,
      boxBefore,
      boxAfter: next.box,
    });

    return {
      boxBefore,
      boxAfter: next.box,
      nextReviewAt: next.nextReviewAt,
      reviewCount: next.reviewCount,
    };
  });
}

/** Every word in the user's deck, shaped for the progress calculation in core. */
export async function getProgressInputs(
  userId: number,
  database: Database = db(),
): Promise<{ box: Box; lastReviewedAt: Date | null; firstSeenAt: Date }[]> {
  const rows = await database
    .select({
      box: userWord.box,
      lastReviewedAt: userWord.lastReviewedAt,
      firstSeenAt: userWord.firstSeenAt,
    })
    .from(userWord)
    .where(eq(userWord.userId, userId));

  return rows.map((r) => ({ ...r, box: isBox(r.box) ? r.box : 1 }));
}

/**
 * Mastered words, for the writing coach's smart injection.
 *
 * Box 4 and 5 only — the requirement is to write using words you have actually
 * mastered, not ones you met yesterday.
 */
export async function getMasteredWords(
  userId: number,
  limit: number,
  minBox = 4,
  database: Database = db(),
): Promise<string[]> {
  const rows = await database
    .select({ lemma: word.lemma })
    .from(userWord)
    .innerJoin(word, eq(word.id, userWord.wordId))
    .where(and(eq(userWord.userId, userId), gte(userWord.box, minBox)))
    .orderBy(sql`random()`)
    .limit(limit);

  return rows.map((r) => r.lemma);
}

/** Look up a single lemma. Needed after a review, when the word is no longer due. */
export async function getWordLemma(
  wordId: number,
  database: Database = db(),
): Promise<string | undefined> {
  const [row] = await database
    .select({ lemma: word.lemma })
    .from(word)
    .where(eq(word.id, wordId));
  return row?.lemma;
}

/** The NGSL word a search query names exactly, if any ("Apple" → apple). */
export async function findWordByLemma(
  lemma: string,
  database: Database = db(),
): Promise<number | undefined> {
  const [row] = await database
    .select({ id: word.id })
    .from(word)
    .where(eq(word.lemma, lemma.trim().toLowerCase()));
  return row?.id;
}

export async function countDeck(userId: number, database: Database = db()): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(userWord)
    .where(eq(userWord.userId, userId));
  return row?.count ?? 0;
}
