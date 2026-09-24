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
export {
  cutWindow,
  snapToSilence,
  parseSilences,
  parseLoudness,
  gainFor,
  type Span,
  type CutOptions,
} from './cut.js';
export {
  downloadSource,
  probe,
  analyzeAudio,
  extractSpeechWav,
  cutClip,
  type MediaInfo,
  type AudioAnalysis,
  type CutResult,
} from './render.js';
export {
  alignSegments,
  alignInChunks,
  alignmentTargets,
  isAlignerConfigured,
  type Alignment,
  type AlignRequest,
  type AlignResponse,
} from './align.js';
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
  buildBaseArgs,
  classifyError,
  mapWithConcurrency,
  sleep,
  YtdlpError,
  type YtdlpErrorKind,
} from './ytdlp.js';

export { probeVideo, type VideoVerdict } from './health.js';
