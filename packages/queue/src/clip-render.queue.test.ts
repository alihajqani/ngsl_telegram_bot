import { describe, expect, it } from 'vitest';
import { clipJobId } from './clip-render.queue.js';

describe('clipJobId', () => {
  it('derives a stable id from the clip id', () => {
    expect(clipJobId(42)).toBe('clip-42');
  });

  it('never contains a colon', () => {
    // BullMQ rejects custom job ids containing ":" because it uses that
    // character in its own Redis key scheme. An earlier version used
    // `clip:<id>`, which made every enqueue throw at runtime while
    // type-checking cleanly.
    for (const id of [1, 999, 1_000_000]) {
      expect(clipJobId(id)).not.toContain(':');
    }
  });

  it('is deterministic, so the same clip always dedupes to one job', () => {
    expect(clipJobId(7)).toBe(clipJobId(7));
  });
});
