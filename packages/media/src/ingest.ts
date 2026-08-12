import { createLogger } from '@ngsl/shared';
import { channel, db, segment, video, word, wordOccurrence, type Database } from '@ngsl/db';
import { eq, sql } from 'drizzle-orm';
import type { ChannelConfig } from './channels.js';
import { enumerateChannel } from './enumerate.js';
import { Lexicon } from './lexicon.js';
import { scoreSegment } from './quality.js';
import { segmentCues, type TextSegment } from './segment.js';
import { fetchManualSubtitles } from './subtitles.js';
import { parseVtt } from './vtt.js';
import { sleep, YtdlpError } from './ytdlp.js';

const log = createLogger('media.ingest');

const SEGMENT_BATCH = 500;

export interface IngestOptions {
  /** How many videos to pull from the channel feed. */
  limit: number;
  /** Pause between videos — the main lever against YouTube's bot wall. */
  delayMs: number;
}

export interface IngestStats {
  channel: string;
  enumerated: number;
  alreadyIndexed: number;
  manual: number;
  noManualSubs: number;
  dead: number;
  failed: number;
  segments: number;
  occurrences: number;
}

/** Load the NGSL lexicon once per run; 2,809 rows, negligible memory. */
export async function loadLexicon(database: Database = db()): Promise<Lexicon> {
  const rows = await database.select({ id: word.id, lemma: word.lemma }).from(word);
  if (rows.length === 0) {
    throw new Error('The word table is empty — run `pnpm db:seed` before ingesting.');
  }
  return new Lexicon(rows);
}

/** Upsert the channel row and return its id. */
export async function ensureChannel(
  config: ChannelConfig,
  database: Database = db(),
): Promise<number> {
  const [row] = await database
    .insert(channel)
    .values({
      ytChannelId: config.slug,
      name: config.name,
      tier: config.tier,
      accent: config.accent ?? null,
      enabled: config.enabled,
    })
    .onConflictDoUpdate({
      target: channel.ytChannelId,
      set: { name: sql`excluded.name`, tier: sql`excluded.tier`, enabled: sql`excluded.enabled` },
    })
    .returning({ id: channel.id });
  return row!.id;
}

/**
 * Ingest one channel end to end: enumerate → manual-subtitle filter → sentence
 * segmentation → NGSL indexing.
 *
 * Videos are processed one at a time and each is committed independently, so a
 * run that trips the bot wall halfway keeps everything it already indexed.
 */
export async function ingestChannel(
  config: ChannelConfig,
  lexicon: Lexicon,
  options: IngestOptions,
  database: Database = db(),
): Promise<IngestStats> {
  const stats: IngestStats = {
    channel: config.slug,
    enumerated: 0,
    alreadyIndexed: 0,
    manual: 0,
    noManualSubs: 0,
    dead: 0,
    failed: 0,
    segments: 0,
    occurrences: 0,
  };

  const channelId = await ensureChannel(config, database);
  const videos = await enumerateChannel(config, options.limit);
  stats.enumerated = videos.length;

  for (const [index, candidate] of videos.entries()) {
    // Register the video first so its verdict is remembered even if we crash.
    const [row] = await database
      .insert(video)
      .values({
        ytVideoId: candidate.ytVideoId,
        channelId,
        title: candidate.title,
        durationS: candidate.durationS,
        subStatus: 'pending',
      })
      .onConflictDoUpdate({
        target: video.ytVideoId,
        set: { title: sql`excluded.title`, durationS: sql`excluded.duration_s` },
      })
      .returning({ id: video.id, subStatus: video.subStatus, indexedAt: video.indexedAt });

    const videoRow = row!;

    // Already decided: either indexed, or known to have no human subtitles.
    if (videoRow.indexedAt !== null) {
      stats.alreadyIndexed++;
      continue;
    }
    if (videoRow.subStatus === 'none') {
      stats.noManualSubs++;
      continue;
    }

    if (index > 0) await sleep(options.delayMs);

    try {
      const result = await fetchManualSubtitles(candidate.ytVideoId);

      if (result.status === 'none') {
        await database
          .update(video)
          .set({ subStatus: 'none', healthCheckedAt: new Date() })
          .where(eq(video.id, videoRow.id));
        stats.noManualSubs++;
        continue;
      }

      const indexed = await indexVideo(videoRow.id, result.vtt!, lexicon, database);
      stats.manual++;
      stats.segments += indexed.segments;
      stats.occurrences += indexed.occurrences;

      log.info('Indexed video', {
        videoId: candidate.ytVideoId,
        lang: result.lang,
        segments: indexed.segments,
        occurrences: indexed.occurrences,
      });
    } catch (error) {
      if (error instanceof YtdlpError && error.kind === 'dead') {
        await database.update(video).set({ status: 'dead' }).where(eq(video.id, videoRow.id));
        stats.dead++;
        continue;
      }
      if (error instanceof YtdlpError && error.kind === 'bot-wall') {
        // Backing off is the only useful response; continuing makes it worse.
        log.error('Hit YouTube bot wall — stopping this channel', { channel: config.slug });
        stats.failed++;
        break;
      }
      stats.failed++;
      log.warn('Video ingest failed', { videoId: candidate.ytVideoId, error });
    }
  }

  log.info('Channel ingest complete', { ...stats });
  return stats;
}

/**
 * Parse one video's subtitles into segments and NGSL occurrences.
 *
 * Runs in a single transaction: a video is either fully indexed or not at all,
 * so `indexed_at` never lies about partial state.
 */
function dedupeByStart(segments: readonly TextSegment[]): TextSegment[] {
  const seen = new Set<number>();
  return segments.filter((s) => {
    if (seen.has(s.startMs)) return false;
    seen.add(s.startMs);
    return true;
  });
}

export async function indexVideo(
  videoId: number,
  vtt: string,
  lexicon: Lexicon,
  database: Database = db(),
): Promise<{ segments: number; occurrences: number }> {
  // Segments are keyed by (video_id, start_ms). Two rows sharing a start_ms in
  // one statement make Postgres raise "ON CONFLICT DO UPDATE command cannot
  // affect row a second time", so collisions are dropped before they reach the
  // insert rather than aborting the whole video.
  const segments = dedupeByStart(segmentCues(parseVtt(vtt)));
  if (segments.length === 0) {
    await database
      .update(video)
      .set({ subStatus: 'manual', indexedAt: new Date() })
      .where(eq(video.id, videoId));
    return { segments: 0, occurrences: 0 };
  }

  return database.transaction(async (tx) => {
    let occurrences = 0;

    for (let i = 0; i < segments.length; i += SEGMENT_BATCH) {
      const batch = segments.slice(i, i + SEGMENT_BATCH);

      const inserted = await tx
        .insert(segment)
        .values(
          batch.map((s) => ({
            videoId,
            startMs: s.startMs,
            endMs: s.endMs,
            text: s.text,
            wordCount: s.wordCount,
          })),
        )
        // Re-ingesting a video must not duplicate its segments.
        .onConflictDoUpdate({
          target: [segment.videoId, segment.startMs],
          set: { text: sql`excluded.text`, endMs: sql`excluded.end_ms` },
        })
        .returning({ id: segment.id, startMs: segment.startMs });

      const idByStart = new Map(inserted.map((r) => [r.startMs, r.id]));

      const rows = batch.flatMap((s) => {
        const segmentId = idByStart.get(s.startMs);
        if (segmentId === undefined) return [];
        const score = scoreSegment(s);
        return [...lexicon.match(s.text)].map((wordId) => ({
          wordId,
          segmentId,
          qualityScore: score,
        }));
      });

      if (rows.length > 0) {
        // Chunked: 20k occurrences × 3 columns would blow the parameter limit.
        for (let j = 0; j < rows.length; j += SEGMENT_BATCH) {
          await tx
            .insert(wordOccurrence)
            .values(rows.slice(j, j + SEGMENT_BATCH))
            .onConflictDoNothing({ target: [wordOccurrence.wordId, wordOccurrence.segmentId] });
        }
        occurrences += rows.length;
      }
    }

    await tx
      .update(video)
      .set({ subStatus: 'manual', indexedAt: new Date() })
      .where(eq(video.id, videoId));

    return { segments: segments.length, occurrences };
  });
}
