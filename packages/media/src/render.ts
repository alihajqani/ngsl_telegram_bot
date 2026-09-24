import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config, createLogger } from '@ngsl/shared';
import { gainFor, parseLoudness, parseSilences, type Span } from './cut.js';
import { runYtdlp } from './ytdlp.js';

const exec = promisify(execFile);
const log = createLogger('media.render');

/**
 * Local media work: one download per source video, every cut done here.
 *
 * v2 asked yt-dlp for each clip separately (`--download-sections`), which
 * re-extracted the same video from YouTube once per clip and let a remote
 * ffmpeg decide where the cut fell. Downloading once and cutting locally turns
 * dozens of YouTube requests into one, and makes every cut frame-accurate and
 * reproducible.
 */

async function ffmpeg(args: string[], timeoutMs = 600_000): Promise<string> {
  const { stderr } = await exec(config().media.ffmpegBin, ['-hide_banner', '-nostdin', ...args], {
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stderr;
}

/**
 * Download the whole source once, capped at the clip height.
 *
 * Every clip is re-encoded anyway, so the source codec does not matter and the
 * smallest file at that height wins (`-S res:<h>,+size`): VP9 or AV1 is often
 * half the size of H.264, and the download is the slow, YouTube-facing step.
 * Matroska holds any codec pair without a remux failing.
 */
export async function downloadSource(ytVideoId: string, dir: string): Promise<string> {
  const h = config().media.maxHeight;
  await runYtdlp(
    [
      '--format',
      `bv*[height<=${h}]+ba/b[height<=${h}]/b`,
      '--format-sort',
      `res:${h},+size,+br`,
      '--merge-output-format',
      'mkv',
      '--no-playlist',
      '-o',
      join(dir, 'source.%(ext)s'),
      `https://www.youtube.com/watch?v=${ytVideoId}`,
    ],
    { timeoutMs: 1_800_000 },
  );

  const file = (await readdir(dir)).find((f) => f.startsWith('source.') && !f.endsWith('.part'));
  if (!file) throw new Error(`yt-dlp produced no source file for ${ytVideoId}`);
  return join(dir, file);
}

export interface MediaInfo {
  durationMs: number;
  width: number;
  height: number;
}

export async function probe(path: string): Promise<MediaInfo> {
  const { stdout } = await exec(
    config().media.ffprobeBin,
    [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      path,
    ],
    { timeout: 60_000 },
  );
  const parsed = JSON.parse(stdout) as {
    streams?: { width?: number; height?: number }[];
    format?: { duration?: string };
  };
  return {
    durationMs: Math.round(Number(parsed.format?.duration ?? 0) * 1000),
    width: parsed.streams?.[0]?.width ?? 0,
    height: parsed.streams?.[0]?.height ?? 0,
  };
}

export interface AudioAnalysis {
  /** Gain that brings this video to the common speech level. */
  gainDb: number;
  /** Pauses, for the no-aligner fallback. */
  silences: Span[];
}

/** One pass over the audio: integrated loudness and every pause. */
export async function analyzeAudio(path: string, durationMs: number): Promise<AudioAnalysis> {
  const stderr = await ffmpeg([
    '-i', path,
    '-vn',
    '-af', 'ebur128=framelog=verbose,silencedetect=noise=-35dB:d=0.15',
    '-f', 'null', '-',
  ]);
  return { gainDb: gainFor(parseLoudness(stderr)), silences: parseSilences(stderr, durationMs) };
}

/** 16 kHz mono PCM — what the wav2vec2 aligner expects. */
export async function extractSpeechWav(path: string, out: string): Promise<string> {
  await ffmpeg(['-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out]);
  return out;
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3);

export interface CutResult {
  path: string;
  thumbnailPath: string;
  width: number;
  height: number;
  durationMs: number;
  sizeBytes: number;
}

/**
 * Cut and encode one clip for Telegram.
 *
 * `-ss` before `-i` with a re-encode is frame-accurate in current ffmpeg, so
 * the clip starts exactly where the window says. The encode is tuned for
 * phones: H.264 at most `CLIP_MAX_HEIGHT` tall, AAC at the per-video gain with
 * a limiter, 40–60 ms fades so neither edge clicks, and `+faststart` so
 * Telegram can start playing before the file has finished loading.
 */
export async function cutClip(
  source: string,
  window: Span,
  options: { gainDb: number; out: string },
): Promise<CutResult> {
  const { maxHeight } = config().media;
  const durationMs = window.endMs - window.startMs;
  const fadeOutAt = Math.max(0, durationMs - 60) / 1000;

  await ffmpeg([
    '-y',
    '-ss', seconds(window.startMs),
    '-i', source,
    '-t', seconds(durationMs),
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-vf', `scale=-2:'trunc(min(${maxHeight},ih)/2)*2',format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '26',
    '-profile:v', 'high',
    '-af',
    [
      `volume=${options.gainDb}dB`,
      'alimiter=limit=0.95:level=0',
      'afade=t=in:st=0:d=0.04',
      `afade=t=out:st=${fadeOutAt.toFixed(3)}:d=0.06`,
    ].join(','),
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ac', '2',
    '-ar', '44100',
    '-movflags', '+faststart',
    options.out,
  ]);

  // Telegram shows this until the video loads; a frame a third of the way in
  // is usually the speaker mid-sentence rather than a transition.
  const thumbnailPath = options.out.replace(/\.mp4$/, '.jpg');
  await ffmpeg([
    '-y',
    '-ss', seconds(Math.round(durationMs / 3)),
    '-i', options.out,
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-q:v', '5',
    thumbnailPath,
  ]);

  const [info, file] = await Promise.all([probe(options.out), stat(options.out)]);
  log.debug('Cut clip', { out: options.out, ...window, sizeBytes: file.size });
  return {
    path: options.out,
    thumbnailPath,
    width: info.width,
    height: info.height,
    durationMs: info.durationMs || durationMs,
    sizeBytes: file.size,
  };
}
