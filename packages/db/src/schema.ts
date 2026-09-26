import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * NGSL Bot v2 — complete relational schema.
 *
 * Three things drove this design, all of them impossible in v1's document model:
 *
 *  1. `user_segment_seen` makes "never show the same clip twice" a join instead
 *     of an unrepresentable requirement. v1 stored clips as an embedded array
 *     with no stable identity, so there was nothing to record as "seen".
 *  2. `word_occurrence` is a precomputed inverted index over the subtitle corpus.
 *     The query vocabulary is closed (2,809 NGSL lemmas known at build time), so
 *     the posting list is built once at ingest and served with `WHERE word_id = $1`.
 *     This is why the design needs no search engine.
 *  3. `points_ledger` is append-only, so every leaderboard is a windowed SUM and
 *     scores stay auditable rather than living in a mutable counter.
 *
 * Convention: `timestamp` is always `withTimezone`. Money-free integers are fine
 * at Number precision, so bigint columns use `mode: 'number'`.
 */

/**
 * Timestamp helper. The column name is a parameter on purpose: an earlier
 * version hardcoded `created_at`, so `seenAt`/`firstSeenAt`/`startedAt` all
 * silently mapped to a column called `created_at` — valid TypeScript, valid
 * Drizzle, and a runtime "column does not exist" the moment raw SQL referenced
 * the name the property implied.
 */
const tsColumn = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

const createdAt = () => tsColumn('created_at');
const updatedAt = () => tsColumn('updated_at');

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const localeEnum = pgEnum('locale', ['fa', 'en']);
export const dictionaryEnum = pgEnum('dictionary', ['cambridge', 'oxford']);
/** Which clips a learner is served, matched against `channel.accent`. */
export const clipAccentEnum = pgEnum('clip_accent', ['us', 'uk', 'any']);
export type ClipAccent = (typeof clipAccentEnum.enumValues)[number];
/** `known` = the user pressed "I know this" and the word jumped straight to box 5. */
export const reviewResultEnum = pgEnum('review_result', ['correct', 'wrong', 'known']);
export const subStatusEnum = pgEnum('sub_status', ['pending', 'manual', 'none']);
export const videoStatusEnum = pgEnum('video_status', ['live', 'dead']);
/** Whether a video's clips have been cut: `rendered` after a pass, `failed` if the source could not be used. */
export const mediaStatusEnum = pgEnum('media_status', ['none', 'rendered', 'failed']);
export const exampleSourceEnum = pgEnum('example_source', ['corpus', 'llm']);
export const phraseKindEnum = pgEnum('phrase_kind', ['collocation', 'idiom']);
export const voteKindEnum = pgEnum('vote_kind', ['like', 'dislike']);
export const buddyStatusEnum = pgEnum('buddy_status', ['pending', 'active', 'ended']);
export const jobStatusEnum = pgEnum('job_status', ['running', 'ok', 'failed']);
export const pointReasonEnum = pgEnum('point_reason', [
  'new_word',
  'review_correct',
  'writing_submitted',
  'clip_watched',
  'daily_goal',
  'streak_milestone',
  'quest_bonus',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

export const appUser = pgTable(
  'app_user',
  {
    id: serial('id').primaryKey(),
    /** Telegram user IDs exceed int32; they are safe integers well past 2^53. */
    telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
    username: varchar('username', { length: 64 }),
    firstName: varchar('first_name', { length: 128 }),
    locale: localeEnum('locale').notNull().default('fa'),
    /** Set when a send fails with 403/"chat not found"; cleared on any interaction. */
    blocked: boolean('blocked').notNull().default(false),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_app_user_telegram_id').on(t.telegramId),
    // Bulk sends walk this: every broadcast excludes blocked users.
    index('idx_app_user_active').on(t.lastActiveAt).where(sql`not ${t.blocked}`),
  ],
);

export const userSettings = pgTable('user_settings', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => appUser.id, { onDelete: 'cascade' }),

  /** Custom daily goals — the requirement v1 hardcoded as WORDS_PER_SESSION = 5. */
  dailyNewTarget: smallint('daily_new_target').notNull().default(5),
  dailyReviewTarget: smallint('daily_review_target').notNull().default(10),

  preferredDictionary: dictionaryEnum('preferred_dictionary').notNull().default('cambridge'),
  /**
   * American by default. `us` or `uk` serves that accent's channels first, then
   * the `mixed` ones, and never the other accent; `any` serves every channel.
   */
  clipAccent: clipAccentEnum('clip_accent').notNull().default('us'),
  remindersEnabled: boolean('reminders_enabled').notNull().default(true),
  motivationEnabled: boolean('motivation_enabled').notNull().default(false),
  digestEnabled: boolean('digest_enabled').notNull().default(true),
  /** Opt-in only — an involuntary public shame list loses users. */
  wallOfShameOptin: boolean('wall_of_shame_optin').notNull().default(false),
  timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Tehran'),
  updatedAt: updatedAt(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Lexicon — seeded from data/ngsl.csv
// (Lemma, SFI Rank, SFI, Adjusted Frequency per Million (U), definition)
// ─────────────────────────────────────────────────────────────────────────────

export const word = pgTable(
  'word',
  {
    id: serial('id').primaryKey(),
    lemma: varchar('lemma', { length: 64 }).notNull(),
    sfiRank: integer('sfi_rank').notNull(),
    sfi: real('sfi'),
    adjFreqPerMillion: integer('adj_freq_per_million'),
    definition: text('definition'),
    /**
     * ntile(10) over frequency descending, computed once by the seeder. This is
     * the "mixed difficulty" guarantee: a batch draws across all ten buckets so
     * it is never all-easy or all-hard. v1 recomputed this in memory per request.
     */
    bucket: smallint('bucket').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_word_lemma').on(t.lemma),
    index('idx_word_bucket').on(t.bucket),
    check('ck_word_bucket_range', sql`${t.bucket} between 1 and 10`),
  ],
);

/**
 * 2–3 contextual sentences per word. Two sources by design:
 *  - `corpus`: mined from our own indexed subtitles — authentic, and because it
 *    keeps `segment_id`, the example can carry a "watch this" button to the clip.
 *  - `llm`: overnight batch fallback for rare words with too few clean hits.
 */
export const wordExample = pgTable(
  'word_example',
  {
    id: serial('id').primaryKey(),
    wordId: integer('word_id')
      .notNull()
      .references(() => word.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    source: exampleSourceEnum('source').notNull(),
    segmentId: bigint('segment_id', { mode: 'number' }),
    qualityScore: real('quality_score').notNull().default(0),
    ord: smallint('ord').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('idx_word_example_word').on(t.wordId, t.ord)],
);

/** 4–5 idioms/collocations per word, served on demand by an inline button. */
export const wordCollocation = pgTable(
  'word_collocation',
  {
    id: serial('id').primaryKey(),
    wordId: integer('word_id')
      .notNull()
      .references(() => word.id, { onDelete: 'cascade' }),
    phrase: varchar('phrase', { length: 160 }).notNull(),
    meaning: text('meaning'),
    kind: phraseKindEnum('kind').notNull().default('collocation'),
    ord: smallint('ord').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_word_collocation_word').on(t.wordId, t.ord),
    uniqueIndex('uq_word_collocation').on(t.wordId, t.phrase),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Learning — Leitner
// ─────────────────────────────────────────────────────────────────────────────

export const userWord = pgTable(
  'user_word',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    wordId: integer('word_id')
      .notNull()
      .references(() => word.id, { onDelete: 'cascade' }),
    /** 1→2→4→8→16 day intervals. Box 5 is "mastered". */
    box: smallint('box').notNull().default(1),
    reviewCount: integer('review_count').notNull().default(0),
    nextReviewAt: timestamp('next_review_at', { withTimezone: true }).notNull(),
    lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }),
    firstSeenAt: tsColumn('first_seen_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.wordId] }),
    // The due-word query: WHERE user_id = $1 AND next_review_at <= now()
    index('idx_user_word_due').on(t.userId, t.nextReviewAt),
    // Writing practice samples each box: WHERE user_id = $1, partitioned by box
    index('idx_user_word_box').on(t.userId, t.box),
    check('ck_user_word_box_range', sql`${t.box} between 1 and 5`),
  ],
);

/** Append-only. Powers streaks, daily-limit counters, and retention analytics. */
export const reviewEvent = pgTable(
  'review_event',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    wordId: integer('word_id')
      .notNull()
      .references(() => word.id, { onDelete: 'cascade' }),
    result: reviewResultEnum('result').notNull(),
    boxBefore: smallint('box_before').notNull(),
    boxAfter: smallint('box_after').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // "How many reviews has this user done since Tehran midnight?" — the daily cap.
    index('idx_review_event_user_time').on(t.userId, t.createdAt),
  ],
);

// ─────────────────────────────────────────────────────────────────────────────
// Corpus — curated channels → videos → segments → occurrences → segment media
// ─────────────────────────────────────────────────────────────────────────────

/** The whitelist. Quality is enforced here, once, instead of per search result. */
export const channel = pgTable(
  'channel',
  {
    id: serial('id').primaryKey(),
    ytChannelId: varchar('yt_channel_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 160 }).notNull(),
    /** 1 = flagship (TED, BBC). Lower tiers are used only to fill gaps. */
    tier: smallint('tier').notNull().default(1),
    /** `us`, `uk` or `mixed`, from `data/channels.yml`. Drives the clip accent setting. */
    accent: varchar('accent', { length: 32 }),
    enabled: boolean('enabled').notNull().default(true),
    lastEnumeratedAt: timestamp('last_enumerated_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_channel_yt_id').on(t.ytChannelId)],
);

export const video = pgTable(
  'video',
  {
    id: serial('id').primaryKey(),
    ytVideoId: varchar('yt_video_id', { length: 16 }).notNull(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    title: text('title'),
    durationS: integer('duration_s'),
    /**
     * `manual` is the only value that qualifies a video for the corpus.
     * `none` means no human-authored English subtitles exist — recorded so the
     * ingest never wastes another request on it.
     */
    subStatus: subStatusEnum('sub_status').notNull().default('pending'),
    status: videoStatusEnum('status').notNull().default('live'),
    /**
     * Position in the channel feed at enumeration, 1 = newest upload. The feed
     * is read once and cached here, so later ingest runs pick the next videos
     * from the database instead of paging through YouTube again.
     */
    feedIndex: integer('feed_index'),
    mediaStatus: mediaStatusEnum('media_status').notNull().default('none'),
    mediaRenderedAt: timestamp('media_rendered_at', { withTimezone: true }),
    healthCheckedAt: timestamp('health_checked_at', { withTimezone: true }),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_video_yt_id').on(t.ytVideoId),
    index('idx_video_channel').on(t.channelId),
    // Ingest picks the next pending videos of a channel in feed order.
    index('idx_video_feed').on(t.channelId, t.feedIndex),
    // Ingest queue: pending videos, oldest first.
    index('idx_video_pending').on(t.createdAt).where(sql`${t.subStatus} = 'pending'`),
    // Weekly health sync: least-recently-probed live videos.
    index('idx_video_health').on(t.healthCheckedAt).where(sql`${t.status} = 'live'`),
  ],
);

/**
 * The raw subtitle track, kept so a video is never asked of YouTube twice:
 * re-segmenting or re-aligning works from this copy.
 */
export const videoSubtitle = pgTable('video_subtitle', {
  videoId: integer('video_id')
    .primaryKey()
    .references(() => video.id, { onDelete: 'cascade' }),
  lang: varchar('lang', { length: 16 }),
  vtt: text('vtt').notNull(),
  fetchedAt: tsColumn('fetched_at'),
});

/** One aligned word inside a segment: text and absolute times in the source video. */
export interface WordTiming {
  w: string;
  s: number;
  e: number;
}

/**
 * A sentence-merged subtitle span. v1 stored raw VTT cues, which break
 * mid-sentence; segments are merged on punctuation so a clip is a whole thought.
 */
export const segment = pgTable(
  'segment',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    videoId: integer('video_id')
      .notNull()
      .references(() => video.id, { onDelete: 'cascade' }),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    text: text('text').notNull(),
    wordCount: smallint('word_count').notNull(),
    /**
     * A whole sentence: it starts where the previous one ended and closes on
     * terminal punctuation. Only complete segments are cut into clips, so a
     * learner never gets half a thought.
     */
    complete: boolean('complete').notNull().default(false),
    active: boolean('active').notNull().default(true),
    /** Forced-alignment result: where the first and last words are really spoken. */
    alignedStartMs: integer('aligned_start_ms'),
    alignedEndMs: integer('aligned_end_ms'),
    /**
     * Mean per-character confidence of the alignment, in [0, 1]. -1 marks a
     * sentence the aligner could not place (an edge word it cannot spell, like
     * a number), so it is cut from subtitle timing and never re-sent.
     */
    alignScore: real('align_score'),
    wordTimings: jsonb('word_timings').$type<WordTiming[]>(),
  },
  (t) => [
    index('idx_segment_video').on(t.videoId),
    uniqueIndex('uq_segment_span').on(t.videoId, t.startMs),
    check('ck_segment_span', sql`${t.endMs} > ${t.startMs}`),
    // Free-text clip search (any word or phrase, YouGlish-style).
    index('idx_segment_fts').using('gin', sql`to_tsvector('english', ${t.text})`),
  ],
);

/**
 * The inverted index. One row per (NGSL lemma, segment) hit, written once at
 * ingest after lemmatization. ~15–20M rows at 5,000 videos — a comfortable
 * single-node Postgres workload.
 */
export const wordOccurrence = pgTable(
  'word_occurrence',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wordId: integer('word_id')
      .notNull()
      .references(() => word.id, { onDelete: 'cascade' }),
    segmentId: bigint('segment_id', { mode: 'number' })
      .notNull()
      .references(() => segment.id, { onDelete: 'cascade' }),
    /** Readability heuristic: length, completeness, rare-word density. */
    qualityScore: real('quality_score').notNull().default(0),
    /** The surface forms the word appeared as ("went" for go) — what a caption bolds. */
    forms: text('forms').array(),
  },
  (t) => [
    // THE hot path — "give me the best occurrences of this word".
    index('idx_word_occurrence_lookup').on(t.wordId, t.qualityScore),
    // Makes re-ingesting a video idempotent.
    uniqueIndex('uq_word_occurrence').on(t.wordId, t.segmentId),
  ],
);

/**
 * The rendered clip of one sentence.
 *
 * Keyed by segment, not by (segment, word): the cut depends only on the
 * sentence, so one file serves every NGSL word the sentence contains. The v2
 * model rendered and uploaded the same bytes once per word.
 *
 * `telegram_file_id` is the whole economic model: minted once by a render and
 * an upload, then reused forever at zero cost.
 */
export const segmentMedia = pgTable(
  'segment_media',
  {
    segmentId: bigint('segment_id', { mode: 'number' })
      .primaryKey()
      .references(() => segment.id, { onDelete: 'cascade' }),
    telegramFileId: text('telegram_file_id').notNull(),
    /** The actual cut, in source-video time. */
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    width: smallint('width'),
    height: smallint('height'),
    sizeBytes: integer('size_bytes'),
    /** True when the cut came from forced alignment rather than subtitle timing. */
    aligned: boolean('aligned').notNull().default(false),
    likes: integer('likes').notNull().default(0),
    dislikes: integer('dislikes').notNull().default(0),
    /** Set by the vote policy, or by an admin. */
    disabled: boolean('disabled').notNull().default(false),
    renderedAt: tsColumn('rendered_at'),
  },
  (t) => [index('idx_segment_media_servable').on(t.segmentId).where(sql`not ${t.disabled}`)],
);

/** Which clips a learner has already watched, so every tap brings fresh ones. */
export const userSegmentSeen = pgTable(
  'user_segment_seen',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    segmentId: bigint('segment_id', { mode: 'number' })
      .notNull()
      .references(() => segment.id, { onDelete: 'cascade' }),
    seenAt: tsColumn('seen_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.segmentId] }),
    index('idx_user_segment_seen_recency').on(t.userId, t.seenAt),
  ],
);

export const segmentVote = pgTable(
  'segment_vote',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    segmentId: bigint('segment_id', { mode: 'number' })
      .notNull()
      .references(() => segment.id, { onDelete: 'cascade' }),
    vote: voteKindEnum('vote').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.segmentId] })],
);

// ─────────────────────────────────────────────────────────────────────────────
// Gamification
// ─────────────────────────────────────────────────────────────────────────────

/** Append-only. Never mutate a balance — every board is a SUM over a window. */
export const pointsLedger = pgTable(
  'points_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    reason: pointReasonEnum('reason').notNull(),
    /** Loose reference to the triggering row (review_event.id, clip.id, …). */
    refId: bigint('ref_id', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [index('idx_points_ledger_user_time').on(t.userId, t.createdAt)],
);

export const userStreak = pgTable('user_streak', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => appUser.id, { onDelete: 'cascade' }),
  current: integer('current').notNull().default(0),
  longest: integer('longest').notNull().default(0),
  /** 'YYYY-MM-DD' in the user's timezone — same shape as v1's lastStudyDay. */
  lastStudyDay: date('last_study_day', { mode: 'string' }),
  /** Earn 1 per 7-day streak, bank up to 2. Consumed automatically on a miss. */
  freezesAvailable: smallint('freezes_available').notNull().default(0),
  /** Compounding points multiplier: ×1.0 → ×1.5 (day 7) → ×2.0 (day 30). */
  multiplier: real('multiplier').notNull().default(1),
  updatedAt: updatedAt(),
});

/** 24-slot histogram driving peak-hour reminders (ported from v1's activityTracker). */
export const activityHour = pgTable(
  'activity_hour',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    hour: smallint('hour').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.hour] }),
    check('ck_activity_hour_range', sql`${t.hour} between 0 and 23`),
  ],
);

/**
 * Weekly leagues of ~30. Top 5 promote, bottom 5 demote. A single global board
 * tells rank 4,120 of 5,000 to quit; a cohort keeps everyone near a boundary.
 */
export const league = pgTable(
  'league',
  {
    id: serial('id').primaryKey(),
    tier: smallint('tier').notNull(),
    /** Saturday (Tehran) that opens the week this cohort covers. */
    weekStart: date('week_start', { mode: 'string' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('idx_league_week').on(t.weekStart, t.tier)],
);

export const leagueMembership = pgTable(
  'league_membership',
  {
    leagueId: integer('league_id')
      .notNull()
      .references(() => league.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    points: integer('points').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.leagueId, t.userId] }),
    index('idx_league_membership_board').on(t.leagueId, t.points),
  ],
);

/** Buddy streaks advance only when BOTH partners studied — the viral loop. */
export const buddyPair = pgTable(
  'buddy_pair',
  {
    id: serial('id').primaryKey(),
    userA: integer('user_a')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    userB: integer('user_b')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    jointStreak: integer('joint_streak').notNull().default(0),
    lastBothStudiedDay: date('last_both_studied_day', { mode: 'string' }),
    status: buddyStatusEnum('status').notNull().default('pending'),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_buddy_user_a').on(t.userA),
    index('idx_buddy_user_b').on(t.userB),
    check('ck_buddy_distinct', sql`${t.userA} <> ${t.userB}`),
  ],
);

/**
 * Pre-generated nightly so the 09:00 send is a DB read, not an LLM fan-out.
 * Falls back to a local 365-quote JSON when generation failed or the user has
 * fewer than 5 learned words.
 */
export const dailyMotivation = pgTable(
  'daily_motivation',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    forDay: date('for_day', { mode: 'string' }).notNull(),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_daily_motivation').on(t.userId, t.forDay)],
);

// ─────────────────────────────────────────────────────────────────────────────
// Writing coach
// ─────────────────────────────────────────────────────────────────────────────

export const writingSession = pgTable(
  'writing_session',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    /** Target words, drawn from the user's highest Leitner boxes. */
    targetLemmas: text('target_lemmas').array().notNull(),
    submittedText: text('submitted_text'),
    correctedText: text('corrected_text'),
    /**
     * Generated from the word list ALONE, in a separate request, so the model
     * never anchors on the student's phrasing. Precomputed when the prompt is
     * shown, so it is ready the instant feedback lands.
     */
    aiSampleText: text('ai_sample_text'),
    score: smallint('score'),
    feedback: text('feedback'),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_writing_session_user').on(t.userId, t.createdAt),
    check('ck_writing_score', sql`${t.score} is null or ${t.score} between 1 and 10`),
  ],
);

/** Rolling per-user memory of recurring mistakes, replayed before each session. */
export const writingSummary = pgTable('writing_summary', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => appUser.id, { onDelete: 'cascade' }),
  grammarPatterns: text('grammar_patterns').array().notNull().default(sql`'{}'`),
  missedVocabulary: text('missed_vocabulary').array().notNull().default(sql`'{}'`),
  sessionCount: integer('session_count').notNull().default(0),
  lastSessionNote: text('last_session_note'),
  updatedAt: updatedAt(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Ops
// ─────────────────────────────────────────────────────────────────────────────

export const broadcast = pgTable('broadcast', {
  id: serial('id').primaryKey(),
  adminId: integer('admin_id')
    .notNull()
    .references(() => appUser.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  sentOk: integer('sent_ok').notNull().default(0),
  sentFailed: integer('sent_failed').notNull().default(0),
  createdAt: createdAt(),
});

/** Durable record of queue runs — replaces v1's in-process, restart-amnesiac cron. */
export const jobRun = pgTable(
  'job_run',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    queue: varchar('queue', { length: 64 }).notNull(),
    jobName: varchar('job_name', { length: 128 }).notNull(),
    status: jobStatusEnum('status').notNull().default('running'),
    startedAt: tsColumn('started_at'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [index('idx_job_run_queue_time').on(t.queue, t.startedAt)],
);

/** Tiny key/value store (last announced version, ingest cursors, …). */
export const appState = pgTable('app_state', {
  key: varchar('key', { length: 96 }).primaryKey(),
  value: text('value').notNull(),
  updatedAt: updatedAt(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Inferred types
// ─────────────────────────────────────────────────────────────────────────────

export type AppUser = typeof appUser.$inferSelect;
export type NewAppUser = typeof appUser.$inferInsert;
export type UserSettings = typeof userSettings.$inferSelect;
export type Word = typeof word.$inferSelect;
export type NewWord = typeof word.$inferInsert;
export type UserWord = typeof userWord.$inferSelect;
export type ReviewEvent = typeof reviewEvent.$inferSelect;
export type Channel = typeof channel.$inferSelect;
export type Video = typeof video.$inferSelect;
export type Segment = typeof segment.$inferSelect;
export type NewSegment = typeof segment.$inferInsert;
export type WordOccurrence = typeof wordOccurrence.$inferSelect;
export type SegmentMedia = typeof segmentMedia.$inferSelect;
export type PointsLedger = typeof pointsLedger.$inferSelect;
export type UserStreak = typeof userStreak.$inferSelect;
export type WritingSession = typeof writingSession.$inferSelect;
