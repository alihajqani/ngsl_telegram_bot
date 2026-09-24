/**
 * Where a clip starts and ends — pure, so every rule here is unit tested.
 *
 * The goal is a YouGlish-clean cut: the clip opens just before the first word
 * of the sentence and closes just after the last, with nothing of the sentences
 * around it. The spoken span comes from forced alignment when the aligner is
 * available, and from subtitle timing snapped to the nearest pause when not.
 */

export interface Span {
  startMs: number;
  endMs: number;
}

export interface CutOptions {
  padBeforeMs: number;
  padAfterMs: number;
  /** A sentence that would need a longer clip is skipped, never truncated. */
  maxMs: number;
  /** End of the previous sentence's last word, when known. */
  prevEndMs?: number;
  /** Start of the next sentence's first word, when known. */
  nextStartMs?: number;
  sourceMs?: number;
}

/**
 * The clip around a spoken span.
 *
 * Padding keeps a breath of silence at both ends, but stops halfway to a
 * neighbouring sentence, so a fast speaker's previous word never leaks in.
 * Returns null for a sentence too long to be a clip: truncating it would end
 * the clip mid-thought, which is exactly what this pipeline exists to avoid.
 */
export function cutWindow(span: Span, options: CutOptions): Span | null {
  let startMs = span.startMs - options.padBeforeMs;
  let endMs = span.endMs + options.padAfterMs;

  if (options.prevEndMs !== undefined && options.prevEndMs <= span.startMs) {
    startMs = Math.max(startMs, Math.round((options.prevEndMs + span.startMs) / 2));
  }
  if (options.nextStartMs !== undefined && options.nextStartMs >= span.endMs) {
    endMs = Math.min(endMs, Math.round((span.endMs + options.nextStartMs) / 2));
  }

  startMs = Math.max(0, startMs);
  if (options.sourceMs !== undefined) endMs = Math.min(endMs, options.sourceMs);

  if (endMs - startMs > options.maxMs || endMs <= startMs) return null;
  return { startMs, endMs };
}

export interface SnapOptions {
  padBeforeMs: number;
  padAfterMs: number;
  /** How far from the subtitle timing a pause may be and still count. */
  searchMs?: number;
}

/**
 * Fallback when there is no alignment: move each edge into the nearest pause.
 *
 * Subtitle timing is typically a few hundred milliseconds off, which is enough
 * to cut a word in half. Speech starts where a pause ends and stops where the
 * next one starts, so those are the anchors. An edge with no pause nearby keeps
 * its subtitle time plus the usual padding. The returned span already carries
 * its padding, so it is cut as-is.
 */
export function snapToSilence(
  span: Span,
  silences: readonly Span[],
  options: SnapOptions,
): { span: Span; snapped: boolean } {
  const searchMs = options.searchMs ?? 700;

  const before = nearest(silences, (s) => s.endMs, span.startMs, searchMs);
  const after = nearest(silences, (s) => s.startMs, span.endMs, searchMs);

  const startMs = before
    ? Math.max(before.startMs, before.endMs - options.padBeforeMs)
    : Math.max(0, span.startMs - options.padBeforeMs);
  const endMs = after
    ? Math.min(after.endMs, after.startMs + options.padAfterMs)
    : span.endMs + options.padAfterMs;

  if (endMs <= startMs) return { span, snapped: false };
  return { span: { startMs, endMs }, snapped: before !== undefined || after !== undefined };
}

function nearest(
  silences: readonly Span[],
  edge: (s: Span) => number,
  target: number,
  searchMs: number,
): Span | undefined {
  let best: Span | undefined;
  let bestDistance = Infinity;
  for (const silence of silences) {
    const distance = Math.abs(edge(silence) - target);
    if (distance <= searchMs && distance < bestDistance) {
      best = silence;
      bestDistance = distance;
    }
  }
  return best;
}

const toMs = (seconds: string): number => Math.round(Number(seconds) * 1000);

/** Parse `silencedetect` output. A pause still open at EOF is closed at `durationMs`. */
export function parseSilences(stderr: string, durationMs?: number): Span[] {
  const silences: Span[] = [];
  let open: number | undefined;

  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      open = Math.max(0, toMs(start[1]!));
      continue;
    }
    const end = /silence_end:\s*([\d.]+)/.exec(line);
    if (end && open !== undefined) {
      silences.push({ startMs: open, endMs: toMs(end[1]!) });
      open = undefined;
    }
  }
  if (open !== undefined && durationMs !== undefined) {
    silences.push({ startMs: open, endMs: durationMs });
  }
  return silences;
}

/** Integrated loudness (LUFS) from the `ebur128` summary, if present. */
export function parseLoudness(stderr: string): number | undefined {
  const summary = stderr.lastIndexOf('Integrated loudness:');
  if (summary === -1) return undefined;
  const match = /I:\s*(-?[\d.]+)\s*LUFS/.exec(stderr.slice(summary));
  return match ? Number(match[1]) : undefined;
}

/** Speech-level target, in line with podcast and streaming norms. */
const TARGET_LUFS = -16;
const MAX_GAIN_DB = 15;

/**
 * One gain per source video, so every clip from every channel plays at about
 * the same volume. Measured once over the whole talk rather than per clip: a
 * per-clip normaliser pumps on short sentences.
 */
export function gainFor(lufs: number | undefined): number {
  if (lufs === undefined || !Number.isFinite(lufs)) return 0;
  const gain = TARGET_LUFS - lufs;
  return Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, Math.round(gain * 10) / 10));
}
