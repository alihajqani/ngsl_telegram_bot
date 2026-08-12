import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Database } from '../client.js';
import { clip, segment, userClipSeen, video, wordOccurrence } from '../schema.js';

/**
 * Clip selection and the per-user "seen" ledger.
 *
 * The requirement — a learner never sees the same clip twice, five fresh clips
 * on learning and five different ones on every review — is unrepresentable in
 * v1's model, where clips were an embedded array with no stable identity. Here
 * it is an anti-join.
 */

/**
 * `db.execute<T>` constrains T to an index-signature type. This keeps the
 * exported interfaces clean while satisfying that constraint at the call site.
 */
type Row<T> = T & Record<string, unknown>;

export interface ServableClip {
  clipId: number;
  ytVideoId: string;
  startMs: number;
  endMs: number;
  telegramFileId: string;
  sentence: string;
}

export interface ClipRenderJob {
  clipId: number;
  ytVideoId: string;
  startMs: number;
  endMs: number;
}

/**
 * Materialize clip rows for a word from its best occurrences.
 *
 * The window is computed here, in SQL, and stored on the row — so a clip's
 * bounds are fixed forever and a re-render reproduces identical bytes. Done as
 * one statement per word rather than a round trip per occurrence.
 */
export async function ensureClipsForWord(
  wordId: number,
  target: number,
  window: { leadMs: number; maxMs: number; tailMs?: number },
  database: Database = db(),
): Promise<number> {
  const { leadMs, maxMs, tailMs = 500 } = window;

  const result = await database.execute(sql`
    insert into ${clip} (segment_id, word_id, start_ms, end_ms)
    select segment_id, word_id, start_ms, end_ms
      from (
        select o.segment_id,
               o.word_id,
               greatest(0, s.start_ms - ${leadMs}) as start_ms,
               least(s.end_ms + ${tailMs}, greatest(0, s.start_ms - ${leadMs}) + ${maxMs}) as end_ms,
               -- Take each video's best occurrence before any video's second.
               -- Ordering by raw quality alone packs the pool with consecutive
               -- lines from whichever single talk happens to score highest,
               -- which leaves the serving query nothing to diversify across.
               row_number() over (
                 partition by v.id
                 order by o.quality_score desc, o.id
               ) as rn
          from ${wordOccurrence} o
          join ${segment} s on s.id = o.segment_id
          join ${video}   v on v.id = s.video_id
         where o.word_id = ${wordId}
           and s.active
           and v.status = 'live'
      ) ranked
     order by rn, random()
     limit ${target}
    on conflict (segment_id, word_id) do nothing
  `);
  return result.count ?? 0;
}

/**
 * Clips this user has never seen, for one word.
 *
 * `row_number() partitioned by video` spreads the batch across different
 * speakers and settings: the learner gets one clip from each of five videos
 * rather than five consecutive lines from the same talk.
 */
export async function selectUnseenClips(
  userId: number,
  wordId: number,
  limit: number,
  database: Database = db(),
): Promise<ServableClip[]> {
  const rows = await database.execute<Row<ServableClip>>(sql`
    select clip_id       as "clipId",
           yt_video_id   as "ytVideoId",
           start_ms      as "startMs",
           end_ms        as "endMs",
           telegram_file_id as "telegramFileId",
           sentence
      from (
        select c.id  as clip_id,
               v.yt_video_id,
               c.start_ms,
               c.end_ms,
               c.telegram_file_id,
               s.text as sentence,
               row_number() over (
                 partition by v.id
                 order by (c.likes - c.dislikes) desc, random()
               ) as rn
          from ${clip} c
          join ${segment} s on s.id = c.segment_id
          join ${video}   v on v.id = s.video_id
         where c.word_id = ${wordId}
           -- NOTE: deliberately NOT filtered on v.status. A rendered clip is a
           -- self-contained file in Telegram's CDN; the source video being
           -- removed from YouTube does not affect playback. Excluding these
           -- would silently discard the vault's whole anti-fragile payoff —
           -- the library is meant to outlive its sources.
           and c.telegram_file_id is not null
           and not c.disabled
           and s.active
           and not exists (
             select 1 from ${userClipSeen} u
              where u.user_id = ${userId} and u.clip_id = c.id
           )
      ) ranked
     order by rn, random()
     limit ${limit}
  `);
  return [...rows];
}

/**
 * Least-recently-seen clips, used only to top up when a word's pool is
 * exhausted. Showing a repeat beats showing nothing.
 */
export async function selectSeenFallback(
  userId: number,
  wordId: number,
  limit: number,
  exclude: readonly number[],
  database: Database = db(),
): Promise<ServableClip[]> {
  const rows = await database.execute<Row<ServableClip>>(sql`
    select c.id as "clipId",
           v.yt_video_id as "ytVideoId",
           c.start_ms as "startMs",
           c.end_ms as "endMs",
           c.telegram_file_id as "telegramFileId",
           s.text as sentence
      from ${clip} c
      join ${segment} s on s.id = c.segment_id
      join ${video}   v on v.id = s.video_id
      join ${userClipSeen} u on u.clip_id = c.id and u.user_id = ${userId}
     where c.word_id = ${wordId}
       -- Same reasoning as selectUnseenClips: a minted file_id keeps working.
       and c.telegram_file_id is not null
       and not c.disabled
       ${exclude.length > 0 ? sql`and c.id <> all(${[...exclude]}::int[])` : sql``}
     order by u.seen_at asc
     limit ${limit}
  `);
  return [...rows];
}

/** Unseen first; only if the pool runs dry does a repeat appear. */
export async function selectClipsForUser(
  userId: number,
  wordId: number,
  limit: number,
  database: Database = db(),
): Promise<{ clips: ServableClip[]; exhausted: boolean }> {
  const unseen = await selectUnseenClips(userId, wordId, limit, database);
  if (unseen.length >= limit) return { clips: unseen, exhausted: false };

  const fallback = await selectSeenFallback(
    userId,
    wordId,
    limit - unseen.length,
    unseen.map((c) => c.clipId),
    database,
  );
  return { clips: [...unseen, ...fallback], exhausted: true };
}

/**
 * Record clips as seen. Idempotent — re-marking is a no-op rather than an error,
 * so a retried send never corrupts the ledger.
 */
export async function markClipsSeen(
  userId: number,
  clipIds: readonly number[],
  database: Database = db(),
): Promise<void> {
  if (clipIds.length === 0) return;
  await database
    .insert(userClipSeen)
    .values(clipIds.map((clipId) => ({ userId, clipId })))
    .onConflictDoNothing();
}

/** Unrendered, servable clips — shared by both backlog queries below. */
const renderable = and(
  isNull(clip.telegramFileId),
  eq(video.status, 'live'),
  eq(clip.disabled, false),
);

const renderJobColumns = {
  clipId: clip.id,
  ytVideoId: video.ytVideoId,
  startMs: clip.startMs,
  endMs: clip.endMs,
};

/**
 * Clips that exist but have never been rendered — the render queue's backlog.
 *
 * Ordered by id so a truncated sweep resumes where the last one stopped. Without
 * it the limit fell on whatever order the heap happened to return, which made
 * two identical sweeps enqueue different work.
 */
export async function findClipsToRender(
  limit: number,
  database: Database = db(),
): Promise<ClipRenderJob[]> {
  const rows = await database
    .select(renderJobColumns)
    .from(clip)
    .innerJoin(segment, eq(segment.id, clip.segmentId))
    .innerJoin(video, eq(video.id, segment.videoId))
    .where(renderable)
    .orderBy(clip.id)
    .limit(limit);
  return rows;
}

/**
 * The same backlog, restricted to one word.
 *
 * This is what a live request needs. `findClipsToRender` answers "what should
 * the sweep work on next", which is a different question: it returns any
 * unrendered clips, so using it to serve a tap on "Watch clips" queued a handful
 * of unrelated words and left the requested one exactly as unrendered as before.
 */
export async function findClipsToRenderForWord(
  wordId: number,
  limit: number,
  database: Database = db(),
): Promise<ClipRenderJob[]> {
  const rows = await database
    .select(renderJobColumns)
    .from(clip)
    .innerJoin(segment, eq(segment.id, clip.segmentId))
    .innerJoin(video, eq(video.id, segment.videoId))
    .where(and(renderable, eq(clip.wordId, wordId)))
    .orderBy(clip.id)
    .limit(limit);
  return rows;
}

/**
 * Persist the reusable Telegram file_id.
 *
 * This is the economic core of the whole pipeline: minted once by an expensive
 * yt-dlp render plus an upload, then reused forever at zero marginal cost. It is
 * never expired — v1's 60-day TTL threw these away and paid to rebuild them.
 */
export async function saveClipFileId(
  clipId: number,
  telegramFileId: string,
  database: Database = db(),
): Promise<void> {
  await database
    .update(clip)
    .set({ telegramFileId, renderedAt: new Date() })
    .where(eq(clip.id, clipId));
}

/** A source video died: stop serving its clips, but keep any minted file_ids — they still play. */
export async function markVideoDead(
  ytVideoId: string,
  database: Database = db(),
): Promise<void> {
  await database.update(video).set({ status: 'dead' }).where(eq(video.ytVideoId, ytVideoId));
}

export async function disableClips(
  clipIds: readonly number[],
  database: Database = db(),
): Promise<void> {
  if (clipIds.length === 0) return;
  await database.update(clip).set({ disabled: true }).where(inArray(clip.id, [...clipIds]));
}

export interface WordClipCoverage {
  wordId: number;
  rendered: number;
  total: number;
}

/** How many rendered clips each word has — drives breadth-then-depth pre-warming. */
export async function clipCoverage(
  database: Database = db(),
): Promise<WordClipCoverage[]> {
  const rows = await database.execute<Row<WordClipCoverage>>(sql`
    select word_id as "wordId",
           count(*) filter (where telegram_file_id is not null)::int as rendered,
           count(*)::int as total
      from ${clip}
     where not disabled
     group by word_id
  `);
  return [...rows];
}
