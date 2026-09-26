import { describe, expect, it } from 'vitest';
import { planRebind, type StagedFileId } from './rebind.js';

const staged = (entries: [number, StagedFileId][]) => new Map(entries);

describe('planRebind', () => {
  it('stages a clip that has no new file_id yet', () => {
    const plan = planRebind([{ segmentId: 1, fileId: 'old-1' }], staged([]));
    expect(plan.toStage).toEqual([1]);
    expect(plan.ready).toEqual([]);
  });

  it('holds a staged clip as ready while the database still has the old file_id', () => {
    const plan = planRebind(
      [{ segmentId: 1, fileId: 'old-1' }],
      staged([[1, { from: 'old-1', to: 'new-1' }]]),
    );
    expect(plan.ready).toEqual([{ segmentId: 1, from: 'old-1', to: 'new-1' }]);
    expect(plan.toStage).toEqual([]);
  });

  it('counts a clip already on its new file_id as applied', () => {
    const plan = planRebind(
      [{ segmentId: 1, fileId: 'new-1' }],
      staged([[1, { from: 'old-1', to: 'new-1' }]]),
    );
    expect(plan.applied).toBe(1);
    expect(plan.toStage).toEqual([]);
    expect(plan.ready).toEqual([]);
  });

  /** The old bot kept rendering while the clips were staged. */
  it('stages again a clip re-rendered since it was staged', () => {
    const plan = planRebind(
      [{ segmentId: 1, fileId: 'rerendered-1' }],
      staged([[1, { from: 'old-1', to: 'new-1' }]]),
    );
    expect(plan.toStage).toEqual([1]);
    expect(plan.ready).toEqual([]);
  });
});
