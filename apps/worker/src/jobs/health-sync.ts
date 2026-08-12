import { markVideoDeadById, markVideoHealthy, videosToProbe } from '@ngsl/db';
import { probeVideo } from '@ngsl/media';
import { config, createLogger } from '@ngsl/shared';

const log = createLogger('worker.health');

/** How many videos one weekly pass probes, and how stale a check may get. */
const BATCH = 300;
const STALE_AFTER_DAYS = 7;

export interface HealthSyncResult {
  probed: number;
  healthy: number;
  dead: number;
  transient: number;
}

/**
 * Weekly source-video health sweep.
 *
 * Uses `yt-dlp --simulate`, which fetches metadata only — no media bytes — so a
 * few hundred probes cost little and stay well inside the pacing budget.
 *
 * The important property is what a dead video does NOT do: clips keep their
 * `telegram_file_id` and continue to play from Telegram's CDN indefinitely.
 * Retiring the source only stops it producing NEW clips. That is the vault's
 * anti-fragile payoff — the library outlives its sources.
 */
export async function runHealthSync(): Promise<HealthSyncResult> {
  const videos = await videosToProbe(BATCH, STALE_AFTER_DAYS);
  const result: HealthSyncResult = { probed: 0, healthy: 0, dead: 0, transient: 0 };

  const delay = config().jobs.requestDelayMs;

  for (const candidate of videos) {
    const verdict = await probeVideo(candidate.ytVideoId);
    result.probed += 1;

    if (verdict === 'live') {
      await markVideoHealthy(candidate.id);
      result.healthy += 1;
    } else if (verdict === 'dead') {
      await markVideoDeadById(candidate.id);
      result.dead += 1;
      log.info('Retired dead source video', { videoId: candidate.ytVideoId });
    } else {
      // Rate limiting or a network blip says nothing about the video; leave
      // health_checked_at untouched so it is retried next sweep.
      result.transient += 1;
      if (verdict === 'bot-wall') {
        log.warn('Hit the bot wall during health sync; stopping this pass');
        break;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  log.info('Health sync complete', { ...result });
  return result;
}
