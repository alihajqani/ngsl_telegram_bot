/**
 * Moving the clip library to a new bot token.
 *
 * A Telegram `file_id` belongs to the bot that minted it: another bot cannot
 * send it. So a new token means uploading every clip again with that token.
 * The new ids are staged next to the old ones and written all at once, so the
 * running bot keeps serving the old ids until the moment the token changes.
 */

export interface ClipFileId {
  segmentId: number;
  /** The file_id the database holds now. */
  fileId: string;
}

export interface StagedFileId {
  /** The file_id the new one replaces. */
  from: string;
  /** The new bot's file_id. */
  to: string;
}

export interface RebindPlan {
  /** No new file_id yet, or re-rendered since it was staged. */
  toStage: number[];
  /** Staged against the file_id the database still holds. */
  ready: ({ segmentId: number } & StagedFileId)[];
  /** Already on the new bot's file_id. */
  applied: number;
}

export function planRebind(
  clips: readonly ClipFileId[],
  staged: ReadonlyMap<number, StagedFileId>,
): RebindPlan {
  const plan: RebindPlan = { toStage: [], ready: [], applied: 0 };
  for (const { segmentId, fileId } of clips) {
    const entry = staged.get(segmentId);
    if (entry?.to === fileId) plan.applied += 1;
    else if (entry?.from === fileId) plan.ready.push({ segmentId, ...entry });
    else plan.toStage.push(segmentId);
  }
  return plan;
}
