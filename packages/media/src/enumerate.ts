import { createLogger } from '@ngsl/shared';
import type { ChannelConfig } from './channels.js';
import { runYtdlp } from './ytdlp.js';

const log = createLogger('media.enumerate');

export interface EnumeratedVideo {
  ytVideoId: string;
  title: string | null;
  durationS: number | null;
}

/** Shorts and stings teach nothing; skip anything under a minute. */
const MIN_DURATION_S = 60;

/**
 * List a channel's uploads.
 *
 * `--flat-playlist` reads the channel feed without extracting each video, which
 * is why v2 needs no YouTube Data API key at all — this replaces the quota-bound
 * `search.list` calls that capped v1 at 10,000 units/day.
 */
export async function enumerateChannel(
  channel: ChannelConfig,
  limit: number,
): Promise<EnumeratedVideo[]> {
  // Negative indices walk from the end of the feed, which is the oldest upload.
  const selection =
    channel.order === 'oldest'
      ? ['--playlist-items', `-${limit}:`]
      : ['--playlist-end', String(limit)];

  const stdout = await runYtdlp(
    ['--flat-playlist', '--dump-json', ...selection, channel.url],
    { timeoutMs: 600_000 },
  );

  const videos: EnumeratedVideo[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let entry: { id?: unknown; title?: unknown; duration?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (typeof entry.id !== 'string' || entry.id === '') continue;

    const durationS = typeof entry.duration === 'number' ? Math.round(entry.duration) : null;
    if (durationS !== null && durationS < MIN_DURATION_S) continue;

    videos.push({
      ytVideoId: entry.id,
      title: typeof entry.title === 'string' ? entry.title : null,
      durationS,
    });
  }

  log.info('Enumerated channel', {
    channel: channel.slug,
    order: channel.order,
    found: videos.length,
  });
  return videos;
}
