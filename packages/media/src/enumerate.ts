import { createLogger } from '@ngsl/shared';
import type { ChannelConfig } from './channels.js';
import { runYtdlp } from './ytdlp.js';

const log = createLogger('media.enumerate');

export interface EnumeratedVideo {
  ytVideoId: string;
  title: string | null;
  durationS: number | null;
  /** Position in the channel feed, 1 = newest upload. */
  feedIndex: number;
}

/** Shorts and stings teach nothing; skip anything under a minute. */
const MIN_DURATION_S = 60;

/**
 * List a channel's whole upload feed.
 *
 * `--flat-playlist` reads the channel feed without extracting each video, which
 * is why v2 needs no YouTube Data API key at all — this replaces the quota-bound
 * `search.list` calls that capped v1 at 10,000 units/day.
 *
 * The whole feed is read, not a slice: reaching the oldest uploads means paging
 * through every newer one anyway (four and a half minutes for TED), so the
 * result is cached in `video.feed_index` and later runs never page again.
 */
export async function enumerateChannel(channel: ChannelConfig): Promise<EnumeratedVideo[]> {
  const stdout = await runYtdlp(['--flat-playlist', '--dump-json', channel.url], {
    timeoutMs: 1_800_000,
  });

  const videos: EnumeratedVideo[] = [];
  let position = 0;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let entry: { id?: unknown; title?: unknown; duration?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (typeof entry.id !== 'string' || entry.id === '') continue;
    position += 1;

    const durationS = typeof entry.duration === 'number' ? Math.round(entry.duration) : null;
    if (durationS !== null && durationS < MIN_DURATION_S) continue;

    videos.push({
      ytVideoId: entry.id,
      title: typeof entry.title === 'string' ? entry.title : null,
      durationS,
      feedIndex: position,
    });
  }

  log.info('Enumerated channel', { channel: channel.slug, found: videos.length });
  return videos;
}
