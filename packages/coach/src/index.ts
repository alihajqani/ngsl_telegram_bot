export {
  sampleSchema,
  feedbackSchema,
  summarySchema,
  checkLength,
  countWords,
  MIN_WORDS,
  MAX_WORDS,
  type SampleResult,
  type WritingFeedback,
  type SummaryUpdate,
  type LengthVerdict,
} from './contracts.js';

export {
  buildSamplePrompt,
  buildFeedbackPrompt,
  buildSummaryPrompt,
  type FeedbackContext,
  type SummaryContext,
} from './prompts.js';

export {
  startWritingSession,
  primeSample,
  ensureSample,
  submitWriting,
  updateMemory,
  NotEnoughWordsError,
  type StartedSession,
  type SubmissionResult,
} from './coach.js';
