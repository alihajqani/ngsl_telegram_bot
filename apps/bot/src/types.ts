import type { Context, SessionFlavor } from 'grammy';
import type { LocaleCode } from './i18n/i18n.js';

/**
 * Session state, kept deliberately small.
 *
 * Only the review queue really needs to persist between updates — everything
 * else is re-read from Postgres, which is the single source of truth. A fat
 * session is how state drifts out of sync with the database.
 */
export interface SessionData {
  /** Word ids still awaiting an answer in the active review session. */
  reviewQueue: number[];
  /** How many were answered, for the closing summary. */
  reviewAnswered: number;
  /** Open writing session, if any. */
  writingSessionId?: number;
  /** Admin is composing a broadcast. */
  awaitingBroadcast?: boolean;
  /** The next text message is a clip search. */
  awaitingSearch?: boolean;
  /**
   * The clip deck on screen: its order is fixed when opened, so the arrows
   * page through a stable list even as clips get marked seen.
   */
  clipDeck?: ClipDeckState;
  /** Cached so the locale middleware can skip a DB read on most updates. */
  locale?: LocaleCode;
  /** Internal user id, cached for the same reason. */
  userId?: number;
}

export interface ClipDeckState {
  /** `w<wordId>` or `q` — what the arrows' callback data refers to. */
  key: string;
  wordId?: number;
  query?: string;
  /** Shown in the caption header: the lemma or the search text. */
  title: string;
  segmentIds: number[];
}

export function initialSession(): SessionData {
  return { reviewQueue: [], reviewAnswered: 0 };
}

export type BotContext = Context & SessionFlavor<SessionData>;
