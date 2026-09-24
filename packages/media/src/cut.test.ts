import { describe, expect, it } from 'vitest';
import { cutWindow, gainFor, parseLoudness, parseSilences, snapToSilence } from './cut.js';

const opts = { padBeforeMs: 250, padAfterMs: 400, maxMs: 20_000 };

describe('cutWindow', () => {
  it('pads the spoken span on both sides', () => {
    expect(cutWindow({ startMs: 10_000, endMs: 14_000 }, opts)).toEqual({
      startMs: 9_750,
      endMs: 14_400,
    });
  });

  it('never reaches into the previous or the next sentence', () => {
    // The neighbours are 100ms away, so the padding stops halfway to them.
    const window = cutWindow({ startMs: 10_000, endMs: 14_000 }, {
      ...opts,
      prevEndMs: 9_900,
      nextStartMs: 14_100,
    });
    expect(window).toEqual({ startMs: 9_950, endMs: 14_050 });
  });

  it('clamps to the source', () => {
    expect(cutWindow({ startMs: 100, endMs: 3_000 }, { ...opts, sourceMs: 3_200 })).toEqual({
      startMs: 0,
      endMs: 3_200,
    });
  });

  it('skips a sentence too long to be a clip instead of cutting it short', () => {
    expect(cutWindow({ startMs: 0, endMs: 25_000 }, opts)).toBeNull();
  });
});

describe('snapToSilence', () => {
  it('moves both edges into the nearest pause', () => {
    // Subtitles say 10.0–14.0s; the speaker really starts at 10.3s and stops at 13.8s.
    const silences = [
      { startMs: 9_600, endMs: 10_300 },
      { startMs: 13_800, endMs: 14_600 },
    ];
    const snapped = snapToSilence({ startMs: 10_000, endMs: 14_000 }, silences, opts);
    expect(snapped.snapped).toBe(true);
    expect(snapped.span).toEqual({ startMs: 10_050, endMs: 14_200 });
  });

  it('pads the subtitle timing on an edge with no pause nearby', () => {
    const snapped = snapToSilence({ startMs: 10_000, endMs: 14_000 }, [{ startMs: 1_000, endMs: 2_000 }], opts);
    expect(snapped.snapped).toBe(false);
    expect(snapped.span).toEqual({ startMs: 9_750, endMs: 14_400 });
  });

  it('snaps one edge and pads the other', () => {
    const snapped = snapToSilence({ startMs: 10_000, endMs: 14_000 }, [{ startMs: 9_600, endMs: 10_300 }], opts);
    expect(snapped.snapped).toBe(true);
    expect(snapped.span).toEqual({ startMs: 10_050, endMs: 14_400 });
  });
});

describe('parseSilences', () => {
  it('reads ffmpeg silencedetect output', () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 1.5',
      '[silencedetect @ 0x1] silence_end: 2.25 | silence_duration: 0.75',
      '[silencedetect @ 0x1] silence_start: 10',
      '[silencedetect @ 0x1] silence_end: 10.4 | silence_duration: 0.4',
    ].join('\n');
    expect(parseSilences(stderr)).toEqual([
      { startMs: 1_500, endMs: 2_250 },
      { startMs: 10_000, endMs: 10_400 },
    ]);
  });

  it('closes a pause still open at the end of the file', () => {
    expect(parseSilences('[silencedetect @ 0x1] silence_start: 5', 6_000)).toEqual([
      { startMs: 5_000, endMs: 6_000 },
    ]);
  });
});

describe('loudness', () => {
  it('reads the integrated loudness from the ebur128 summary', () => {
    const stderr = `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -23.4 LUFS\n    Threshold: -33.6 LUFS`;
    expect(parseLoudness(stderr)).toBe(-23.4);
    expect(parseLoudness('no summary here')).toBeUndefined();
  });

  it('brings every video to the same level, within a safe range', () => {
    expect(gainFor(-23.4)).toBeCloseTo(7.4);
    expect(gainFor(-60)).toBe(15);
    expect(gainFor(undefined)).toBe(0);
  });
});
