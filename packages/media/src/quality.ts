import type { TextSegment } from './segment.js';

/**
 * Score how good a segment is as a teaching example, in [0, 1].
 *
 * This drives `word_occurrence.quality_score`, which orders the clips a learner
 * is offered. It is a ranking signal rather than a filter: a mediocre clip is
 * still better than no clip when a word is rare, so nothing is discarded here.
 */

/** Long enough to carry meaning, short enough to hold attention. */
const IDEAL_MIN_WORDS = 8;
const IDEAL_MAX_WORDS = 20;

/** Natural speech sits near 2–4 words/second. Far outside is rushed or padded. */
const IDEAL_MIN_WPS = 1.8;
const IDEAL_MAX_WPS = 4.2;

export function scoreSegment(segment: TextSegment): number {
  return clamp01(
    0.4 * lengthScore(segment.wordCount) +
      0.25 * (segment.complete ? 1 : 0) +
      0.2 * paceScore(segment) +
      0.15 * cleanlinessScore(segment.text),
  );
}

function lengthScore(words: number): number {
  if (words >= IDEAL_MIN_WORDS && words <= IDEAL_MAX_WORDS) return 1;
  const distance =
    words < IDEAL_MIN_WORDS ? IDEAL_MIN_WORDS - words : words - IDEAL_MAX_WORDS;
  return clamp01(1 - distance / 15);
}

function paceScore(segment: TextSegment): number {
  const seconds = (segment.endMs - segment.startMs) / 1000;
  if (seconds <= 0) return 0;
  const wps = segment.wordCount / seconds;
  if (wps >= IDEAL_MIN_WPS && wps <= IDEAL_MAX_WPS) return 1;
  const distance = wps < IDEAL_MIN_WPS ? IDEAL_MIN_WPS - wps : wps - IDEAL_MAX_WPS;
  return clamp01(1 - distance / 3);
}

/**
 * Penalize text that reads badly out of context: shouted capitals, leftover
 * annotation brackets, or a sentence starting mid-clause on a conjunction.
 */
function cleanlinessScore(text: string): number {
  let score = 1;
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length > 0) {
    const upperRatio = (text.match(/[A-Z]/g)?.length ?? 0) / letters.length;
    if (upperRatio > 0.5) score -= 0.5;
  }
  if (/[[\]()]/.test(text)) score -= 0.2;
  if (/^(and|but|or|so|because|which|that)\b/i.test(text.trim())) score -= 0.25;
  if (!/^[A-Z"']/.test(text.trim())) score -= 0.15;
  return clamp01(score);
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
