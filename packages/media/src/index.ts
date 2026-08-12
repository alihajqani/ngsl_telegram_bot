export {
  parseChannelsYaml,
  loadChannels,
  enabledChannels,
  ChannelConfigError,
  type ChannelConfig,
  type CrawlOrder,
} from './channels.js';

export { parseVtt, cleanCueText, timestampToMs, VttParseError, type Cue } from './vtt.js';

export {
  segmentCues,
  endsSentence,
  stripNonSpeech,
  countWords,
  type TextSegment,
  type SegmentOptions,
} from './segment.js';

export { Lexicon, type LexiconEntry } from './lexicon.js';
export { clipWindow, renderClip, type ClipWindow, type ClipWindowOptions } from './clip.js';
export { scoreSegment } from './quality.js';
export { enumerateChannel, type EnumeratedVideo } from './enumerate.js';
export { fetchManualSubtitles, pickPreferredTrack, type SubtitleResult } from './subtitles.js';

export {
  ingestChannel,
  indexVideo,
  loadLexicon,
  ensureChannel,
  type IngestOptions,
  type IngestStats,
} from './ingest.js';

export {
  runYtdlp,
  baseArgs,
  classifyError,
  mapWithConcurrency,
  sleep,
  YtdlpError,
  type YtdlpErrorKind,
} from './ytdlp.js';

export { probeVideo, type VideoVerdict } from './health.js';
