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
  /** Cached so the locale middleware can skip a DB read on most updates. */
  locale?: LocaleCode;
  /** Internal user id, cached for the same reason. */
  userId?: number;
}

export function initialSession(): SessionData {
  return { reviewQueue: [], reviewAnswered: 0 };
}

export type BotContext = Context & SessionFlavor<SessionData>;
