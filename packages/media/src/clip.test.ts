import { describe, expect, it } from 'vitest';
import { clipWindow } from './clip.js';

const OPTS = { leadMs: 3_000, maxMs: 14_000 };

describe('clipWindow', () => {
  it('adds lead-in before the sentence starts', () => {
    expect(clipWindow({ startMs: 10_000, endMs: 15_000 }, OPTS)).toEqual({
      startMs: 7_000,
      endMs: 15_500,
    });
  });

  it('never seeks before the start of the video', () => {
    const window = clipWindow({ startMs: 1_000, endMs: 5_000 }, OPTS);
    expect(window.startMs).toBe(0);
  });

  it('caps a long sentence at the maximum clip length', () => {
    const window = clipWindow({ startMs: 30_000, endMs: 90_000 }, OPTS);
    expect(window.startMs).toBe(27_000);
    expect(window.endMs - window.startMs).toBe(14_000);
  });

  it('extends a very short sentence to a watchable minimum', () => {
    // A 400ms sentence would otherwise render as an unwatchable flash.
    const window = clipWindow({ startMs: 20_000, endMs: 20_400 }, { ...OPTS, minMs: 2_000 });
    expect(window.endMs - window.startMs).toBeGreaterThanOrEqual(2_000);
  });

  it('keeps a tail so the last word is not cut mid-syllable', () => {
    const window = clipWindow({ startMs: 10_000, endMs: 14_000 }, { ...OPTS, tailMs: 500 });
    expect(window.endMs).toBe(14_500);
  });

  it('is deterministic — the same segment always yields the same bounds', () => {
    // Windows are persisted on the clip row, so a re-render must reproduce
    // identical bytes and the cached file_id stays valid.
    const segment = { startMs: 12_345, endMs: 18_765 };
    expect(clipWindow(segment, OPTS)).toEqual(clipWindow(segment, OPTS));
  });

  it('always produces a positive-length window', () => {
    for (const segment of [
      { startMs: 0, endMs: 1 },
      { startMs: 500, endMs: 600 },
      { startMs: 99_000, endMs: 99_050 },
    ]) {
      const window = clipWindow(segment, OPTS);
      expect(window.endMs).toBeGreaterThan(window.startMs);
    }
  });
});
