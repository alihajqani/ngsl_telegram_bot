import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '@ngsl/shared';
import { runYtdlp } from './ytdlp.js';

export interface SubtitleResult {
  status: 'manual' | 'none';
  /** Raw VTT contents, present only when status is 'manual'. */
  vtt?: string;
  /** The track that was chosen, e.g. `en`, `en-GB`, `en-US`. */
  lang?: string;
}

/**
 * Fetch HUMAN-AUTHORED English subtitles for a video, or report that none exist.
 *
 * The requirement is "accurate subtitles, not auto-generated", and this function
 * is where it is enforced. Two details carry the whole guarantee:
 *
 *  1. `--write-subs` WITHOUT `--write-auto-subs`. yt-dlp only writes
 *     auto-generated tracks when explicitly asked; omitting the flag means a
 *     video with nothing but machine captions produces no file at all. v1 used
 *     `--write-auto-sub`, which is exactly the behaviour being replaced.
 *  2. `--sub-langs "en.*"` rather than `en`. Measured against the whitelist,
 *     BBC Learning English publishes `en-GB` and Vox publishes `en-US`; matching
 *     only `en` would silently discard both channels.
 *
 * Absence of a file is a real answer, not a failure — the caller records
 * `sub_status='none'` so the video is never probed again.
 */
export async function fetchManualSubtitles(ytVideoId: string): Promise<SubtitleResult> {
  const dir = await mkdtemp(join(config().media.tmpDir, `subs-${ytVideoId}-`));

  try {
    await runYtdlp(
      [
        '--skip-download',
        '--write-subs',
        '--sub-langs', 'en.*',
        '--sub-format', 'vtt/best',
        '--convert-subs', 'vtt',
        '-o', join(dir, '%(id)s.%(ext)s'),
        `https://www.youtube.com/watch?v=${ytVideoId}`,
      ],
      { timeoutMs: 180_000 },
    );

    const files = (await readdir(dir)).filter((f) => f.endsWith('.vtt'));
    if (files.length === 0) {
      return { status: 'none' };
    }

    const chosen = pickPreferredTrack(files);
    return {
      status: 'manual',
      vtt: await readFile(join(dir, chosen), 'utf8'),
      lang: languageOf(chosen),
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Filenames look like `<id>.en.vtt` / `<id>.en-GB.vtt`. */
function languageOf(filename: string): string | undefined {
  return /\.([A-Za-z-]+)\.vtt$/.exec(filename)?.[1];
}

/**
 * Prefer a plain `en` track, then any regional variant. Ordering is only about
 * consistency — every one of these is human-authored.
 */
export function pickPreferredTrack(files: readonly string[]): string {
  const sorted = [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return sorted[0]!;
}

function rank(filename: string): number {
  const lang = languageOf(filename)?.toLowerCase() ?? '';
  if (lang === 'en') return 0;
  if (lang === 'en-us' || lang === 'en-gb') return 1;
  if (lang.startsWith('en')) return 2;
  return 3;
}
