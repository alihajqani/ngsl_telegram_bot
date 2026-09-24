import { and, asc, eq, sql } from 'drizzle-orm';
import { db, type Database } from '../client.js';
import {
  channel,
  segment,
  segmentMedia,
  segmentVote,
  userSegmentSeen,
  video,
  wordOccurrence,
  type WordTiming,
} from '../schema.js';

/**
 * Clips: serving, the per-user "seen" ledger, votes, and render planning.
 *
 * A clip is one sentence (`segment`) cut once into `segment_media`. It serves
 * every NGSL word in that sentence, so the words map to clips through
 * `word_occurrence` rather than through a per-word copy of the same file.
 */

/**
 * `db.execute<T>` constrains T to an index-signature type. This keeps the
 * exported interfaces clean while satisfying that constraint at the call site.
 */
type Row<T> = T & Record<string, unknown>;

/**
 * A list of ids as ONE Postgres array parameter.
 *
 * Interpolating a JS array into `sql` expands it to a tuple — `($1, $2, $3)` —
 * which Postgres cannot cast to an array, so `= any(${ids}::int[])` fails at
 * runtime while type-checking cleanly. An array literal string is a single
 * parameter, and `'{}'` covers the empty list.
 */
const idArray = (ids: readonly number[], type: 'int' | 'bigint') =>
  sql`${`{${ids.map((id) => Math.trunc(Number(id))).join(',')}}`}::${sql.raw(type)}[]`;

// ─────────────────────────────────────────────────────────────────────────────
// Serving
// ─────────────────────────────────────────────────────────────────────────────

export interface ClipDeck {
  /** Ordered: never-seen clips first, spread across videos; then least recently seen. */
  segmentIds: number[];
  unseen: number;
}

/**
 * The order a learner meets a word's clips in.
 *
 * Unseen clips come first, and within them the first clip of every video comes
 * before any video's second (`row_number() partition by video`), so paging
 * through the deck moves between speakers instead of walking one talk. Seen
 * clips follow, least recently seen first: a repeat beats an empty screen.
 *
 * Not filtered on `video.status`: a rendered clip is a file in Telegram's CDN,
 * and a source removed from YouTube does not stop it playing.
 */
export async function clipDeckForWord(
  userId: number,
  wordId: number,
  limit: number,
  database: Database = db(),
): Promise<ClipDeck> {
  const rows = await database.execute<Row<{ segmentId: number; seen: boolean }>>(sql`
    select segment_id as "segmentId", seen_at is not null as seen
      from (
        select s.id as segment_id,
               us.seen_at,
               (m.likes - m.dislikes) as net,
               o.quality_score as quality,
               row_number() over (
                 partition by s.video_id, (us.seen_at is null)
                 order by (m.likes - m.dislikes) desc, o.quality_score desc, s.id
               ) as rn
          from ${wordOccurrence} o
          join ${segment} s on s.id = o.segment_id
          join ${segmentMedia} m on m.segment_id = s.id
          left join ${userSegmentSeen} us on us.segment_id = s.id and us.user_id = ${userId}
         where o.word_id = ${wordId}
           and s.active
           and not m.disabled
      ) ranked
     order by (seen_at is not null),
              case when seen_at is null then rn end,
              seen_at,
              net desc,
              quality desc,
              segment_id
     limit ${limit}
  `);
  const list = [...rows];
  return { segmentIds: list.map((r) => Number(r.segmentId)), unseen: list.filter((r) => !r.seen).length };
}

/**
 * Free-text search over every rendered clip: any word or phrase, YouGlish-style.
 * `phraseto_tsquery` keeps word order, so "look forward to" finds that phrase
 * rather than three scattered words.
 */
export async function clipDeckForQuery(
  userId: number,
  query: string,
  limit: number,
  database: Database = db(),
): Promise<ClipDeck> {
  const rows = await database.execute<Row<{ segmentId: number; seen: boolean }>>(sql`
    select s.id as "segmentId", us.seen_at is not null as seen
      from ${segment} s
      join ${segmentMedia} m on m.segment_id = s.id
      left join ${userSegmentSeen} us on us.segment_id = s.id and us.user_id = ${userId}
     where to_tsvector('english', s.text) @@ phraseto_tsquery('english', ${query})
       and s.active
       and not m.disabled
     order by (us.seen_at is not null),
              us.seen_at,
              ts_rank(to_tsvector('english', s.text), phraseto_tsquery('english', ${query})) desc,
              (m.likes - m.dislikes) desc,
              s.id
     limit ${limit}
  `);
  const list = [...rows];
  return { segmentIds: list.map((r) => Number(r.segmentId)), unseen: list.filter((r) => !r.seen).length };
}

export interface ServableClip {
  segmentId: number;
  telegramFileId: string;
  sentence: string;
  /**
   * The sentence with the search hit wrapped in \u0001…\u0002, when served for
   * a text query. The caller escapes the text and turns the markers into tags.
   */
  marked?: string;
  /** Surface forms of the word being studied ("went" for go), when served for a word. */
  forms?: string[];
  ytVideoId: string;
  channelName: string;
  /** Where the clip starts in the source, for a "watch on YouTube" link. */
  startMs: number;
  likes: number;
  dislikes: number;
}

export async function getServableClip(
  segmentId: number,
  context: { wordId?: number; query?: string },
  database: Database = db(),
): Promise<ServableClip | undefined> {
  const { wordId, query } = context;
  const marked = query
    ? sql`ts_headline('english', s.text, phraseto_tsquery('english', ${query}),
            'StartSel=' || chr(1) || ', StopSel=' || chr(2) || ', HighlightAll=true')`
    : sql`null`;
  const forms =
    wordId !== undefined
      ? sql`(select o.forms from ${wordOccurrence} o where o.segment_id = s.id and o.word_id = ${wordId})`
      : sql`null`;

  const [row] = await database.execute<Row<ServableClip>>(sql`
    select s.id as "segmentId",
           m.telegram_file_id as "telegramFileId",
           s.text as sentence,
           ${marked} as marked,
           ${forms} as forms,
           v.yt_video_id as "ytVideoId",
           c.name as "channelName",
           m.start_ms as "startMs",
           m.likes,
           m.dislikes
      from ${segment} s
      join ${segmentMedia} m on m.segment_id = s.id
      join ${video} v on v.id = s.video_id
      join ${channel} c on c.id = v.channel_id
     where s.id = ${segmentId}
  `);
  if (!row) return undefined;
  return {
    ...row,
    segmentId: Number(row.segmentId),
    marked: row.marked ?? undefined,
    forms: row.forms ?? undefined,
  };
}

/** Idempotent, so a retried send never corrupts the ledger. */
export async function markSegmentSeen(
  userId: number,
  segmentId: number,
  database: Database = db(),
): Promise<void> {
  await database
    .insert(userSegmentSeen)
    .values({ userId, segmentId })
    .onConflictDoUpdate({
      target: [userSegmentSeen.userId, userSegmentSeen.segmentId],
      set: { seenAt: new Date() },
    });
}

/** Votes needed before a clip can be switched off, and the dislike share that does it. */
const VOTE_FLOOR = 5;
const DISLIKE_SHARE = 2 / 3;

/**
 * Record one learner's vote (re-voting replaces it) and apply the policy: with
 * at least five votes, a clip two-thirds disliked is taken out of rotation.
 */
export async function voteSegment(
  userId: number,
  segmentId: number,
  vote: 'like' | 'dislike',
  database: Database = db(),
): Promise<{ likes: number; dislikes: number; disabled: boolean }> {
  return database.transaction(async (tx) => {
    await tx
      .insert(segmentVote)
      .values({ userId, segmentId, vote })
      .onConflictDoUpdate({
        target: [segmentVote.userId, segmentVote.segmentId],
        set: { vote, createdAt: new Date() },
      });

    const [tally] = await tx
      .select({
        likes: sql<number>`count(*) filter (where ${segmentVote.vote} = 'like')::int`,
        dislikes: sql<number>`count(*) filter (where ${segmentVote.vote} = 'dislike')::int`,
      })
      .from(segmentVote)
      .where(eq(segmentVote.segmentId, segmentId));

    const likes = tally?.likes ?? 0;
    const dislikes = tally?.dislikes ?? 0;
    const total = likes + dislikes;
    const disabled = total >= VOTE_FLOOR && dislikes / total >= DISLIKE_SHARE;

    await tx
      .update(segmentMedia)
      .set({ likes, dislikes, ...(disabled ? { disabled: true } : {}) })
      .where(eq(segmentMedia.segmentId, segmentId));

    return { likes, dislikes, disabled };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage and render planning
// ─────────────────────────────────────────────────────────────────────────────

/** How many enabled clips each word has: `word_id → count`. */
const coveredCte = sql`
  covered as (
    select o.word_id, count(*)::int as n
      from ${wordOccurrence} o
      join ${segmentMedia} m on m.segment_id = o.segment_id and not m.disabled
     group by o.word_id
  )`;

export interface WordClipCoverage {
  wordId: number;
  rendered: number;
}

/** Rendered clips for just these words — the cheap check on a session's hot path. */
export async function clipCountsFor(
  wordIds: readonly number[],
  database: Database = db(),
): Promise<Map<number, number>> {
  if (wordIds.length === 0) return new Map();
  const rows = await database.execute<Row<WordClipCoverage>>(sql`
    select o.word_id as "wordId", count(*)::int as rendered
      from ${wordOccurrence} o
      join ${segmentMedia} m on m.segment_id = o.segment_id and not m.disabled
     where o.word_id = any(${idArray(wordIds, 'int')})
     group by o.word_id
  `);
  return new Map([...rows].map((r) => [r.wordId, r.rendered]));
}

/** Rendered clips per word — drives the pre-warm sweep and `pnpm prewarm --status`. */
export async function wordCoverage(database: Database = db()): Promise<WordClipCoverage[]> {
  const rows = await database.execute<Row<WordClipCoverage>>(sql`
    with ${coveredCte}
    select w.id as "wordId", coalesce(c.n, 0)::int as rendered
      from word w
      left join covered c on c.word_id = w.id
  `);
  return [...rows];
}

export async function renderedClipCount(database: Database = db()): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(segmentMedia)
    .where(eq(segmentMedia.disabled, false));
  return row?.n ?? 0;
}

/**
 * Eligibility for cutting: a whole sentence whose text is not known to mismatch
 * the audio. Unaligned (null) and unalignable (-1) sentences stay eligible and
 * are cut from subtitle timing.
 */
const renderable = (minScore: number) => sql`
  s.active and s.complete
  and (s.align_score is null or s.align_score < 0 or s.align_score >= ${minScore})`;

export interface VideoToRender {
  videoId: number;
  ytVideoId: string;
  /** Under-covered words this video's sentences would help. */
  gain: number;
}

/**
 * Which source videos to download next.
 *
 * One download yields many clips, so the choice is by marginal gain: the
 * number of words still below `target` that the video can help. Greedy, but it
 * is what makes breadth fill fastest per YouTube request.
 */
export async function videosToRender(
  target: number,
  limit: number,
  minScore: number,
  database: Database = db(),
): Promise<VideoToRender[]> {
  const rows = await database.execute<Row<VideoToRender>>(sql`
    with ${coveredCte},
    need as (
      select w.id as word_id from word w
        left join covered c on c.word_id = w.id
       where coalesce(c.n, 0) < ${target}
    )
    select v.id as "videoId", v.yt_video_id as "ytVideoId", count(distinct o.word_id)::int as gain
      from need n
      join ${wordOccurrence} o on o.word_id = n.word_id
      join ${segment} s on s.id = o.segment_id
      join ${video} v on v.id = s.video_id
     where ${renderable(minScore)}
       and v.status = 'live'
       and v.media_status = 'none'
       and v.indexed_at is not null
     group by v.id
     order by gain desc, v.id
     limit ${limit}
  `);
  return [...rows];
}

/** Unrendered videos holding a good sentence for this word — a learner is waiting on it. */
export async function videosForWord(
  wordId: number,
  limit: number,
  minScore: number,
  database: Database = db(),
): Promise<Omit<VideoToRender, 'gain'>[]> {
  const rows = await database.execute<Row<Omit<VideoToRender, 'gain'>>>(sql`
    select v.id as "videoId", v.yt_video_id as "ytVideoId"
      from ${wordOccurrence} o
      join ${segment} s on s.id = o.segment_id
      join ${video} v on v.id = s.video_id
     where o.word_id = ${wordId}
       and ${renderable(minScore)}
       and v.status = 'live'
       and v.media_status = 'none'
     group by v.id
     order by max(o.quality_score) desc, v.id
     limit ${limit}
  `);
  return [...rows];
}

export interface VideoSegment {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
  complete: boolean;
  alignedStartMs: number | null;
  alignedEndMs: number | null;
  alignScore: number | null;
}

/** Every segment of a video in time order — neighbours matter to where a cut may reach. */
export async function videoSegments(
  videoId: number,
  database: Database = db(),
): Promise<VideoSegment[]> {
  return database
    .select({
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
      complete: segment.complete,
      alignedStartMs: segment.alignedStartMs,
      alignedEndMs: segment.alignedEndMs,
      alignScore: segment.alignScore,
    })
    .from(segment)
    .where(and(eq(segment.videoId, videoId), eq(segment.active, true)))
    .orderBy(asc(segment.startMs));
}

/**
 * The sentences of one video worth cutting, best first: those holding a word a
 * learner is waiting for, then those helping the most under-covered words.
 * Sentences already cut, or whose alignment says the text is not what is
 * spoken, are left out.
 */
export async function renderPlan(
  videoId: number,
  focusWordIds: readonly number[],
  target: number,
  maxClips: number,
  minScore: number,
  database: Database = db(),
): Promise<number[]> {
  const focus = idArray(focusWordIds, 'int');
  const rows = await database.execute<Row<{ id: number }>>(sql`
    with ${coveredCte}
    select s.id
      from ${segment} s
      join ${wordOccurrence} o on o.segment_id = s.id
      left join covered c on c.word_id = o.word_id
     where s.video_id = ${videoId}
       and ${renderable(minScore)}
       and not exists (select 1 from ${segmentMedia} m where m.segment_id = s.id)
     group by s.id
    having bool_or(o.word_id = any(${focus}))
        or count(*) filter (where coalesce(c.n, 0) < ${target}) > 0
     order by bool_or(o.word_id = any(${focus})) desc,
              count(*) filter (where coalesce(c.n, 0) < ${target}) desc,
              max(o.quality_score) desc,
              min(s.start_ms)
     limit ${maxClips}
  `);
  return [...rows].map((r) => Number(r.id));
}

export interface AlignmentUpdate {
  segmentId: number;
  alignedStartMs: number;
  alignedEndMs: number;
  alignScore: number;
  wordTimings: WordTiming[];
}

export async function saveAlignments(
  updates: readonly AlignmentUpdate[],
  database: Database = db(),
): Promise<void> {
  for (const u of updates) {
    await database
      .update(segment)
      .set({
        alignedStartMs: u.alignedStartMs,
        alignedEndMs: u.alignedEndMs,
        alignScore: u.alignScore,
        wordTimings: u.wordTimings,
      })
      .where(eq(segment.id, u.segmentId));
  }
}

/** Sentences the aligner could not place: cut from subtitle timing, never re-sent. */
export async function markUnalignable(
  segmentIds: readonly number[],
  database: Database = db(),
): Promise<void> {
  if (segmentIds.length === 0) return;
  await database.execute(sql`
    update ${segment} set align_score = -1
     where id = any(${idArray(segmentIds, 'bigint')}) and align_score is null
  `);
}

export interface NewSegmentMedia {
  segmentId: number;
  telegramFileId: string;
  startMs: number;
  endMs: number;
  width: number;
  height: number;
  sizeBytes: number;
  aligned: boolean;
}

/**
 * Persist the reusable Telegram file_id — minted once, reused forever at zero
 * cost. Never expired: v1's 60-day TTL threw these away and paid to rebuild them.
 */
export async function saveSegmentMedia(
  media: NewSegmentMedia,
  database: Database = db(),
): Promise<void> {
  await database
    .insert(segmentMedia)
    .values(media)
    .onConflictDoUpdate({
      target: segmentMedia.segmentId,
      set: {
        telegramFileId: media.telegramFileId,
        startMs: media.startMs,
        endMs: media.endMs,
        width: media.width,
        height: media.height,
        sizeBytes: media.sizeBytes,
        aligned: media.aligned,
        renderedAt: new Date(),
      },
    });
}

export async function setVideoMediaStatus(
  videoId: number,
  status: 'none' | 'rendered' | 'failed',
  database: Database = db(),
): Promise<void> {
  await database
    .update(video)
    .set({ mediaStatus: status, mediaRenderedAt: status === 'none' ? null : new Date() })
    .where(eq(video.id, videoId));
}
