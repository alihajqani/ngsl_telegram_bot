import type { Cue } from './vtt.js';

/**
 * Merge subtitle cues into sentence-shaped segments.
 *
 * This is the difference between a teaching artifact and a confusing fragment.
 * Raw VTT cues break wherever the caption line filled up:
 *
 *   [12.3s] "and that's why the apple"
 *   [15.2s] "fell from the tree, which led Newton"
 *
 * v1 clipped those cues directly, so a learner looking up "apple" got a clip
 * ending mid-thought. Here consecutive cues are accumulated until the text
 * actually closes a sentence.
 */

export interface TextSegment {
  startMs: number;
  endMs: number;
  text: string;
  wordCount: number;
  /** True when the text closes on terminal punctuation — a quality signal, not a filter. */
  complete: boolean;
}

export interface SegmentOptions {
  /** Segments longer than this are flushed early so a clip stays clip-sized. */
  maxDurationMs?: number;
  maxWords?: number;
  minWords?: number;
}

const DEFAULTS = {
  maxDurationMs: 16_000,
  maxWords: 45,
  minWords: 4,
} satisfies Required<SegmentOptions>;

/**
 * A trailing period here is an abbreviation, not a sentence end. Without this,
 * "Dr. King said" splits into two useless fragments.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'lt', 'gen', 'sgt', 'rev',
  'vs', 'etc', 'eg', 'ie', 'approx', 'est', 'fig', 'no', 'vol', 'inc', 'ltd', 'co',
  'am', 'pm', 'us', 'uk', 'eu', 'un',
]);

/** Non-speech annotations: [APPLAUSE], (laughter), ♪ lyrics ♪. */
const NON_SPEECH = /[[(][^\])]*[\])]|♪|♫/g;

const TERMINAL = /[.!?…]["'”’)\]]*$/;

export function stripNonSpeech(text: string): string {
  return text.replace(NON_SPEECH, ' ').replace(/\s+/g, ' ').trim();
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/** Does this text close a sentence? Abbreviations and initials do not count. */
export function endsSentence(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!TERMINAL.test(trimmed)) return false;
  // Only a period is ambiguous; "!" and "?" always terminate.
  if (!/\.["'”’)\]]*$/.test(trimmed)) return true;

  const lastWord = /([\w.]+)\.["'”’)\]]*$/.exec(trimmed)?.[1]?.toLowerCase();
  if (!lastWord) return true;
  // "J." / "F." — a lone initial, as in "J. F. Kennedy".
  if (lastWord.length === 1) return false;
  // "U.S." / "e.g." — internal dots mark an abbreviation.
  if (lastWord.includes('.')) return false;
  return !ABBREVIATIONS.has(lastWord);
}

/**
 * Rolling captions repeat the previous line as they scroll. Detect a cue whose
 * text is already the tail of what we've accumulated.
 */
function isRedundant(accumulated: string, next: string): boolean {
  if (next === '') return true;
  if (accumulated === '') return false;
  const tail = accumulated.slice(-next.length);
  return tail.toLowerCase() === next.toLowerCase();
}

const TERMINAL_SCAN = /[.!?…]["'”’)\]]*/g;

/**
 * Index just past the first sentence-ending punctuation, or -1.
 *
 * Sentence ends do NOT line up with cue boundaries — a single cue routinely
 * carries "Good morning. Today we will talk", which is one finished sentence
 * plus the start of another. Scanning inside the buffer is what lets those be
 * separated.
 */
export function findSentenceEnd(text: string): number {
  TERMINAL_SCAN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TERMINAL_SCAN.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (endsSentence(text.slice(0, end))) return end;
  }
  return -1;
}

/** One cue's worth of text, carrying the timing it came from. */
interface Piece {
  text: string;
  startMs: number;
  endMs: number;
}

/** Which piece contains `charIndex` in the space-joined buffer, and where inside it. */
function locate(pieces: readonly Piece[], charIndex: number): { index: number; local: number } {
  let offset = 0;
  for (const [index, piece] of pieces.entries()) {
    if (charIndex <= offset + piece.text.length) {
      return { index, local: charIndex - offset };
    }
    offset += piece.text.length + 1; // +1 for the joining space
  }
  const last = pieces.length - 1;
  return { index: last, local: pieces[last]!.text.length };
}

export function segmentCues(cues: readonly Cue[], options: SegmentOptions = {}): TextSegment[] {
  const { maxDurationMs, maxWords, minWords } = { ...DEFAULTS, ...options };

  const segments: TextSegment[] = [];
  let buffer: Piece[] = [];

  const bufferText = (): string => buffer.map((p) => p.text).join(' ');

  const emit = (pieces: readonly Piece[], raw: string): void => {
    if (pieces.length === 0) return;
    const text = stripNonSpeech(raw);
    const wordCount = countWords(text);
    if (wordCount < minWords) return;
    segments.push({
      // Timing comes from whole cues, so a clip opens and closes on caption
      // boundaries rather than mid-syllable.
      startMs: pieces[0]!.startMs,
      endMs: pieces[pieces.length - 1]!.endMs,
      text,
      wordCount,
      complete: endsSentence(text),
    });
  };

  for (const cue of cues) {
    const text = cue.text.trim();
    if (isRedundant(bufferText(), text)) continue;

    // Flush BEFORE appending, so an oversized cue starts the next segment
    // rather than being swallowed into an already-full one.
    if (buffer.length > 0) {
      const overDuration = cue.endMs - buffer[0]!.startMs > maxDurationMs;
      const overWords = countWords(`${bufferText()} ${text}`) > maxWords;
      if (overDuration || overWords) {
        emit(buffer, bufferText());
        buffer = [];
      }
    }

    buffer.push({ text, startMs: cue.startMs, endMs: cue.endMs });

    // Drain every complete sentence now sitting in the buffer.
    for (;;) {
      const joined = bufferText();
      const end = findSentenceEnd(joined);
      if (end === -1) break;

      const { index, local } = locate(buffer, end);
      const boundary = buffer[index]!;
      const head = boundary.text.slice(0, local).trimEnd();
      const tail = boundary.text.slice(local).trimStart();

      /**
       * Interpolate the cue's timing at the split point instead of giving both
       * halves the cue's own bounds. Two reasons: a sentence starting halfway
       * through a 4-second cue really does start ~2s in, and identical
       * timestamps would collide on the `(video_id, start_ms)` unique index.
       */
      const ratio = boundary.text.length === 0 ? 1 : local / boundary.text.length;
      const splitMs = Math.round(
        boundary.startMs + ratio * (boundary.endMs - boundary.startMs),
      );

      const taken = buffer.slice(0, index);
      if (head !== '') taken.push({ ...boundary, text: head, endMs: splitMs });

      buffer = [
        ...(tail === '' ? [] : [{ ...boundary, text: tail, startMs: splitMs }]),
        ...buffer.slice(index + 1),
      ];

      emit(taken, joined.slice(0, end));
    }
  }

  emit(buffer, bufferText());
  return segments;
}
