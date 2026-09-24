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

interface AlignResponse {
  results: ({ id: number; ok: true; startMs: number; endMs: number; score: number; words: WordTiming[] } | { id: number; ok: false })[];
}

export function isAlignerConfigured(): boolean {
  return config().media.alignerUrl !== undefined;
}

/**
 * Align every segment of one video. `audioPath` must be visible to the aligner
 * too: both containers mount the same clip scratch volume.
 *
 * Returns undefined when the aligner could not be asked at all (logged, not
 * thrown), so an outage degrades cuts to the fallback instead of stopping
 * renders, and the caller can tell "not aligned" from "could not be aligned".
 */
export async function alignSegments(
  audioPath: string,
  segments: readonly AlignRequest[],
): Promise<Map<number, Alignment> | undefined> {
  const url = config().media.alignerUrl;
  const aligned = new Map<number, Alignment>();
  if (!url) return undefined;
  if (segments.length === 0) return aligned;

  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/align`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: audioPath, segments }),
      // CPU alignment of a long talk takes minutes, not seconds.
      signal: AbortSignal.timeout(20 * 60_000),
    });
    if (!response.ok) {
      log.warn('Aligner returned an error', { status: response.status, body: await response.text() });
      return undefined;
    }
    const body = (await response.json()) as AlignResponse;
    for (const result of body.results) {
      if (result.ok) aligned.set(result.id, result);
    }
  } catch (error) {
    log.warn('Aligner unreachable; falling back to subtitle timing', { error });
    return undefined;
  }
  return aligned;
}
