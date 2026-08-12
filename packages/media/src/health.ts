import { createLogger } from '@ngsl/shared';
import { runYtdlp, YtdlpError } from './ytdlp.js';

const log = createLogger('media.health');

export type VideoVerdict = 'live' | 'dead' | 'transient' | 'bot-wall';

/**
 * Probe a source video without downloading it.
 *
 * `--simulate` performs extraction and prints what it would do, so the whole
 * check costs a metadata request. A transient verdict is deliberately distinct
 * from `dead`: rate limiting says nothing about the video, and treating it as
 * death would silently shrink the corpus during an outage.
 */
export async function probeVideo(ytVideoId: string): Promise<VideoVerdict> {
  try {
    await runYtdlp(
      ['--simulate', '--skip-download', '--no-playlist', `https://www.youtube.com/watch?v=${ytVideoId}`],
      { timeoutMs: 60_000 },
    );
    return 'live';
  } catch (error) {
    if (!(error instanceof YtdlpError)) return 'transient';
    if (error.kind === 'dead' || error.kind === 'drm') return 'dead';
    if (error.kind === 'bot-wall') return 'bot-wall';
    log.debug('Transient probe failure', { videoId: ytVideoId });
    return 'transient';
  }
}
