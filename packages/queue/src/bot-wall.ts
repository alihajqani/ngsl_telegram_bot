import { redisClient } from './connection.js';

/**
 * The bot-wall circuit breaker.
 *
 * When YouTube answers "confirm you're not a bot" or rate-limits the session,
 * every further request makes the block longer. So the first job to see it
 * trips this breaker, and every YouTube-facing job checks it before starting.
 * It lives in Redis rather than in memory so a restart cannot quietly resume
 * the hammering, and the key expires on its own when the pause is over.
 */

const KEY = 'media:bot-wall-until';

/** Pause all YouTube traffic for `ms`. Returns when the pause ends. */
export async function tripBotWall(ms: number): Promise<Date> {
  const until = Date.now() + ms;
  await redisClient().set(KEY, String(until), 'PX', ms);
  return new Date(until);
}

/** Milliseconds left in the current pause; 0 when YouTube may be contacted. */
export async function botWallRemainingMs(): Promise<number> {
  const value = await redisClient().get(KEY);
  return value === null ? 0 : Math.max(0, Number(value) - Date.now());
}
