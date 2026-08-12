/**
 * WebVTT parser.
 *
 * Deliberately faithful: it decodes and de-tags cue text but does not judge it.
 * Dropping non-speech ([APPLAUSE], ♪) and scoring readability happen later, in
 * segmentation and quality scoring, so each stage stays testable in isolation.
 */

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

export class VttParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VttParseError';
  }
}

/** `HH:MM:SS.mmm` or `MM:SS.mmm`; VTT allows either, and SRT-style commas appear in the wild. */
const TIMESTAMP = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const CUE_TIMING = new RegExp(`^\\s*${TIMESTAMP.source}\\s*-->\\s*${TIMESTAMP.source}`);

/** Blocks that carry no dialogue. */
const NON_CUE_BLOCK = /^(WEBVTT|NOTE\b|STYLE\b|REGION\b|Kind:|Language:)/;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&#39;': "'",
};

export function timestampToMs(value: string): number {
  const m = TIMESTAMP.exec(value);
  if (!m) throw new VttParseError(`Unparseable VTT timestamp: ${value}`);
  const [, h, min, sec, frac] = m;
  // A 1- or 2-digit fraction is tenths/hundredths, not milliseconds.
  const ms = Number(frac!.padEnd(3, '0'));
  return Number(h ?? 0) * 3_600_000 + Number(min) * 60_000 + Number(sec) * 1_000 + ms;
}

/**
 * Strip styling and inline karaoke timing tags, decode entities, collapse space.
 *
 * `<00:00:01.234>` and `<c>` markers are what make raw cue text unusable as a
 * sentence; auto-generated tracks are full of them, and manual tracks carry
 * `<i>`/`<b>` often enough to matter.
 */
export function cleanCueText(raw: string): string {
  let text = raw.replace(/<[^>]*>/g, '');
  for (const [entity, char] of Object.entries(ENTITIES)) {
    text = text.replaceAll(entity, char);
  }
  text = text.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
  // ">>" marks a speaker change; "-" at line start is a dialogue dash.
  text = text.replace(/^\s*(?:>>+|-)\s*/gm, '');
  return text.replace(/\s+/g, ' ').trim();
}

export function parseVtt(content: string): Cue[] {
  const normalized = content.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const blocks = normalized.split(/\n{2,}/);
  const cues: Cue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    if (NON_CUE_BLOCK.test(lines[0]!.trim())) continue;

    // An optional cue identifier may precede the timing line.
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex === -1) continue;

    const timingLine = lines[timingIndex]!;
    if (!CUE_TIMING.test(timingLine)) continue;

    // Split on the arrow and let timestampToMs find the first timestamp on each
    // side — that way trailing cue settings ("align:start position:0%") are
    // ignored without having to parse them.
    const [left, right] = timingLine.split('-->');
    const startMs = timestampToMs(left!);
    const endMs = timestampToMs(right!);

    const text = cleanCueText(lines.slice(timingIndex + 1).join('\n'));
    if (text === '') continue;
    if (endMs <= startMs) continue;

    cues.push({ startMs, endMs, text });
  }

  return cues.sort((a, b) => a.startMs - b.startMs);
}
