import type { WordTiming } from '@ngsl/db/schema';
import { config, createLogger } from '@ngsl/shared';

const log = createLogger('media.align');

/**
 * Client for the forced-alignment sidecar (`services/aligner`).
 *
 * Human subtitles give the right words at roughly the right time. The aligner
 * matches those words against the audio with a wav2vec2 CTC model and returns
 * when each one is really spoken, which is what makes a cut land just before
 * the first word and just after the last. Optional: without it, cuts fall back
 * to subtitle timing snapped to the nearest pause.
 */

export interface AlignRequest {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface Alignment {
  id: number;
  startMs: number;
  endMs: number;
  /** Mean per-character confidence in [0, 1]; low means the text is not what is said. */
  score: number;
  words: WordTiming[];
}

export interface AlignResponse {
  results: ({ id: number; ok: true; startMs: number; endMs: number; score: number; words: WordTiming[] } | { id: number; ok: false })[];
}

/**
 * Sentences per request. The aligner answers only when a whole request is
 * done, and Node's fetch drops a request whose response headers take over
 * five minutes. On a one-core server a whole talk took longer than that, so
 * every alignment was lost; 25 sentences finish in well under a minute.
 */
const CHUNK_SIZE = 25;

export function isAlignerConfigured(): boolean {
  return config().media.alignerUrl !== undefined;
}

/**
 * Which sentences to align: the ones about to be cut and their immediate
 * neighbours (whose word times keep a cut from reaching into them), skipping
 * any already aligned. `segments` must be in time order.
 */
export function alignmentTargets(
  segments: readonly { id: number; alignScore: number | null }[],
  planIds: readonly number[],
): number[] {
  const planned = new Set(planIds);
  const wanted = new Set<number>();
  segments.forEach((segment, index) => {
    if (!planned.has(segment.id)) return;
    for (const neighbour of [segments[index - 1], segment, segments[index + 1]]) {
      if (neighbour && neighbour.alignScore === null) wanted.add(neighbour.id);
    }
  });
  return segments.filter((s) => wanted.has(s.id)).map((s) => s.id);
}

/**
 * Align in batches. The map holds an alignment for each placed sentence and
 * `null` for each the aligner answered it could not place; sentences never
 * answered (a later batch failed) are absent, so they are not written off.
 * Undefined when the aligner never answered at all.
 */
export async function alignInChunks(
  segments: readonly AlignRequest[],
  post: (chunk: readonly AlignRequest[]) => Promise<AlignResponse>,
  chunkSize = CHUNK_SIZE,
): Promise<Map<number, Alignment | null> | undefined> {
  const aligned = new Map<number, Alignment | null>();
  for (let i = 0; i < segments.length; i += chunkSize) {
    let body: AlignResponse;
    try {
      body = await post(segments.slice(i, i + chunkSize));
    } catch (error) {
      log.warn('Aligner request failed; keeping what was aligned', {
        answered: aligned.size,
        of: segments.length,
        error,
      });
      return aligned.size === 0 ? undefined : aligned;
    }
    for (const result of body.results) aligned.set(result.id, result.ok ? result : null);
  }
  return aligned;
}

/**
 * Align sentences of one video. `audioPath` must be visible to the aligner
 * too: both containers mount the same clip scratch volume.
 *
 * An unreachable aligner is logged, not thrown, so an outage degrades cuts to
 * the fallback instead of stopping renders.
 */
export async function alignSegments(
  audioPath: string,
  segments: readonly AlignRequest[],
): Promise<Map<number, Alignment | null> | undefined> {
  const url = config().media.alignerUrl;
  if (!url) return undefined;
  if (segments.length === 0) return new Map();

  return alignInChunks(segments, async (chunk) => {
    const response = await fetch(`${url.replace(/\/$/, '')}/align`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: audioPath, segments: chunk }),
      signal: AbortSignal.timeout(4 * 60_000),
    });
    if (!response.ok) {
      throw new Error(`Aligner responded ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as AlignResponse;
  });
}
