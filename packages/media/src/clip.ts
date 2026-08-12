import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config, createLogger } from '@ngsl/shared';
import { runYtdlp } from './ytdlp.js';

const log = createLogger('media.clip');

export interface ClipWindow {
  startMs: number;
  endMs: number;
}

export interface ClipWindowOptions {
  leadMs: number;
  maxMs: number;
  /** Small tail so the final word is not clipped mid-syllable. */
  tailMs?: number;
  minMs?: number;
}

/**
 * The render window around a sentence.
 *
 * v1 used a fixed 3s-lead / 10s-length window for every clip, deliberately, so
 * that a cached `file_id` always matched what a fresh cut would produce. v2 gets
 * that determinism for free instead: the window is computed once when the clip
 * row is created and persisted on it, so re-rendering always reproduces the same
 * bytes while still letting each clip match its own sentence length.
 */
export function clipWindow(
  segment: { startMs: number; endMs: number },
  options: ClipWindowOptions,
): ClipWindow {
  const { leadMs, maxMs, tailMs = 500, minMs = 2_000 } = options;

  const startMs = Math.max(0, segment.startMs - leadMs);
  const natural = segment.endMs + tailMs;
  const endMs = Math.min(natural, startMs + maxMs);

  // A very short sentence still needs enough runtime to be watchable.
  return { startMs, endMs: Math.max(endMs, Math.min(startMs + minMs, natural)) };
}

const toSeconds = (ms: number): string => (ms / 1000).toFixed(2);

/**
 * Cut a single section out of a YouTube video without downloading the whole file.
 *
 * `--download-sections` makes yt-dlp issue ranged requests for just the bytes in
 * the window, which is what keeps rendering cheap enough to pre-warm thousands
 * of clips. Capped at 480p — these are 10-second vocabulary clips on a phone,
 * and height is the dominant term in both render time and upload size.
 *
 * Returns the path to an mp4 the caller owns and MUST delete.
 */
export async function renderClip(
  ytVideoId: string,
  window: ClipWindow,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(config().media.tmpDir, `clip-${ytVideoId}-`));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    await runYtdlp(
      [
        '--download-sections',
        `*${toSeconds(window.startMs)}-${toSeconds(window.endMs)}`,
        // Re-encode the cut section; stream-copying would snap to keyframes and
        // drift the window by seconds, which is fatal for a 10-second clip.
        '--force-keyframes-at-cuts',
        '--format',
        'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best',
        '--merge-output-format',
        'mp4',
        '-o',
        join(dir, '%(id)s.%(ext)s'),
        `https://www.youtube.com/watch?v=${ytVideoId}`,
      ],
      { timeoutMs: 300_000 },
    );

    const files = (await readdir(dir)).filter((f) => f.endsWith('.mp4'));
    if (files.length === 0) {
      throw new Error(`yt-dlp produced no output for ${ytVideoId}`);
    }

    log.debug('Rendered clip', { videoId: ytVideoId, ...window });
    return { path: join(dir, files[0]!), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
