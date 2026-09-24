import { describe, expect, it } from 'vitest';
import { mergeFocus, videoJobId } from './video-render.queue.js';

describe('videoJobId', () => {
  it('derives a stable id from the video id', () => {
    expect(videoJobId(42)).toBe('video-42');
  });

  it('never contains a colon', () => {
    // BullMQ rejects custom job ids containing ":" because it uses that
    // character in its own Redis key scheme. An earlier version used
    // `clip:<id>`, which made every enqueue throw at runtime while
    // type-checking cleanly.
    for (const id of [1, 999, 1_000_000]) {
      expect(videoJobId(id)).not.toContain(':');
    }
  });

  it('is deterministic, so one video always dedupes to one job', () => {
    expect(videoJobId(7)).toBe(videoJobId(7));
  });
});

describe('mergeFocus', () => {
  it('adds newly requested words without duplicating queued ones', () => {
    expect(mergeFocus([3, 5], [5, 9])).toEqual([3, 5, 9]);
  });

  it('reports no change when every word is already queued', () => {
    expect(mergeFocus([3, 5], [5])).toBeUndefined();
  });
});
