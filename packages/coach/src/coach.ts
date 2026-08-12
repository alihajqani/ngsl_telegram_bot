import {
  createWritingSession,
  findOpenSession,
  getMasteredWords,
  getWritingSummary,
  saveAiSample,
  saveSubmission,
  upsertWritingSummary,
  type WritingSummaryRecord,
} from '@ngsl/db';
import { completeJson } from '@ngsl/llm';
import { createLogger } from '@ngsl/shared';
import {
  feedbackSchema,
  sampleSchema,
  summarySchema,
  type WritingFeedback,
} from './contracts.js';
import { buildFeedbackPrompt, buildSamplePrompt, buildSummaryPrompt } from './prompts.js';

const log = createLogger('coach');

/** How many mastered words to inject into a prompt. */
const TARGET_WORDS = 5;

/**
 * Words are drawn from the top Leitner boxes. Falling back to box 3 keeps the
 * feature usable for a learner who has not yet mastered five words, rather than
 * refusing outright.
 */
const PREFERRED_MIN_BOX = 4;
const FALLBACK_MIN_BOX = 3;

export interface StartedSession {
  sessionId: number;
  lemmas: string[];
  summary: WritingSummaryRecord | undefined;
}

export class NotEnoughWordsError extends Error {
  constructor(readonly have: number) {
    super('The learner has too few mastered words for a writing session');
    this.name = 'NotEnoughWordsError';
  }
}

/**
 * Begin a writing session.
 *
 * Returns as soon as the prompt is ready. The independent sample is generated
 * separately — see `primeSample` — so the learner is never left waiting on an
 * LLM before they can start typing.
 */
export async function startWritingSession(userId: number): Promise<StartedSession> {
  let lemmas = await getMasteredWords(userId, TARGET_WORDS, PREFERRED_MIN_BOX);
  if (lemmas.length < 3) {
    lemmas = await getMasteredWords(userId, TARGET_WORDS, FALLBACK_MIN_BOX);
  }
  if (lemmas.length < 3) throw new NotEnoughWordsError(lemmas.length);

  const [sessionId, summary] = await Promise.all([
    createWritingSession(userId, lemmas),
    getWritingSummary(userId),
  ]);

  return { sessionId, lemmas, summary };
}

/**
 * Generate the independent native sample and store it.
 *
 * Called fire-and-forget the moment the prompt is shown, so it is normally
 * ready long before the learner finishes writing — the comparison then costs no
 * perceived latency. A failure here is not surfaced: `ensureSample` regenerates
 * on demand at submission time.
 */
export async function primeSample(sessionId: number, lemmas: readonly string[]): Promise<void> {
  try {
    const result = await completeJson(buildSamplePrompt(lemmas), sampleSchema, {
      temperature: 0.8,
      maxOutputTokens: 512,
    });
    await saveAiSample(sessionId, result.text.trim());
    log.debug('Primed independent sample', { sessionId });
  } catch (error) {
    log.warn('Sample priming failed; will retry on submission', { sessionId, error });
  }
}

/** Return the primed sample, generating it now if priming did not finish. */
export async function ensureSample(
  sessionId: number,
  lemmas: readonly string[],
  existing: string | null,
): Promise<string | undefined> {
  if (existing) return existing;
  try {
    const result = await completeJson(buildSamplePrompt(lemmas), sampleSchema, {
      temperature: 0.8,
      maxOutputTokens: 512,
    });
    const text = result.text.trim();
    await saveAiSample(sessionId, text);
    return text;
  } catch (error) {
    log.warn('Sample generation failed', { sessionId, error });
    return undefined;
  }
}

export interface SubmissionResult {
  feedback: WritingFeedback;
  /** Absent only if the model failed twice; the rest of the reply still stands. */
  sample: string | undefined;
}

/**
 * Grade a submission and produce the comparison.
 *
 * Ordering matters: feedback and the corrected text come first, then the
 * independent sample. The learner should reckon with their own writing before
 * being shown a native version of the same task.
 */
export async function submitWriting(
  userId: number,
  text: string,
): Promise<SubmissionResult | undefined> {
  const session = await findOpenSession(userId);
  if (!session) return undefined;

  const summary = await getWritingSummary(userId);

  const feedback = await completeJson(
    buildFeedbackPrompt({
      lemmas: session.targetLemmas,
      text,
      priorPatterns: summary?.grammarPatterns,
    }),
    feedbackSchema,
    { temperature: 0.3, maxOutputTokens: 2048 },
  );

  const sample = await ensureSample(session.id, session.targetLemmas, session.aiSampleText);

  await saveSubmission(session.id, {
    submittedText: text,
    correctedText: feedback.correctedText,
    score: feedback.score,
    feedback: feedback.overallComment,
  });

  // The memory update is a third call and must not delay the reply, nor fail it.
  void updateMemory(userId, feedback, summary).catch((error: unknown) =>
    log.warn('Writing summary update failed', { userId, error }),
  );

  return { feedback, sample };
}

/** Fold this session into the learner's rolling memory. */
export async function updateMemory(
  userId: number,
  feedback: WritingFeedback,
  prior: WritingSummaryRecord | undefined,
): Promise<void> {
  const update = await completeJson(
    buildSummaryPrompt({
      feedback,
      prior: prior
        ? { grammarPatterns: prior.grammarPatterns, missedVocabulary: prior.missedVocabulary }
        : undefined,
    }),
    summarySchema,
    { temperature: 0.2, maxOutputTokens: 512 },
  );

  await upsertWritingSummary(userId, {
    grammarPatterns: update.grammarPatterns,
    missedVocabulary: update.missedVocabulary,
    lastSessionNote: update.lastSessionNote,
  });
  log.info('Writing memory updated', { userId, patterns: update.grammarPatterns.length });
}
