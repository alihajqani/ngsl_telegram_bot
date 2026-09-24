import { describe, expect, it } from 'vitest';
import { alignInChunks, alignmentTargets, type AlignRequest, type AlignResponse } from './align.js';

const request = (id: number): AlignRequest => ({ id, startMs: id * 1000, endMs: id * 1000 + 800, text: `s${id}` });

const answer = (ids: readonly number[], unalignable: readonly number[] = []): AlignResponse => ({
  results: ids.map((id) =>
    unalignable.includes(id)
      ? { id, ok: false as const }
      : { id, ok: true as const, startMs: id * 1000 + 50, endMs: id * 1000 + 700, score: 0.9, words: [] },
  ),
});

describe('alignInChunks', () => {
  it('asks in small batches so no single request outlives the HTTP timeout', async () => {
    const sizes: number[] = [];
    const result = await alignInChunks(
      Array.from({ length: 60 }, (_, i) => request(i)),
      (chunk) => {
        sizes.push(chunk.length);
        return Promise.resolve(answer(chunk.map((s) => s.id)));
      },
      25,
    );
    expect(sizes).toEqual([25, 25, 10]);
    expect(result?.size).toBe(60);
  });

  it('records a sentence the aligner could not place as null, not as missing', async () => {
    const result = await alignInChunks(
      [request(1), request(2)],
      (chunk) => Promise.resolve(answer(chunk.map((s) => s.id), [2])),
      25,
    );
    expect(result?.get(1)?.startMs).toBe(1050);
    expect(result?.get(2)).toBeNull();
  });

  it('keeps the batches already answered when a later one fails', async () => {
    let calls = 0;
    const result = await alignInChunks(
      Array.from({ length: 30 }, (_, i) => request(i)),
      (chunk) => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error('fetch failed'));
        return Promise.resolve(answer(chunk.map((s) => s.id)));
      },
      25,
    );
    expect(result?.size).toBe(25);
    // The unanswered sentences are absent, so nobody marks them unalignable.
    expect(result?.has(27)).toBe(false);
  });

  it('reports an aligner that never answered as undefined', async () => {
    const result = await alignInChunks([request(1)], () => Promise.reject(new Error('fetch failed')), 25);
    expect(result).toBeUndefined();
  });
});

describe('alignmentTargets', () => {
  const segments = [0, 1, 2, 3, 4, 5, 6].map((id) => ({ id, alignScore: null as number | null }));

  it('aligns the sentences to cut and their neighbours, not the whole video', () => {
    expect(alignmentTargets(segments, [3])).toEqual([2, 3, 4]);
    expect(alignmentTargets(segments, [0, 6])).toEqual([0, 1, 5, 6]);
  });

  it('skips sentences that already carry an alignment', () => {
    const partly = segments.map((s) => (s.id === 2 ? { ...s, alignScore: 0.9 } : s));
    expect(alignmentTargets(partly, [3])).toEqual([3, 4]);
  });
});
