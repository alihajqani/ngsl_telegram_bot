import { z } from 'zod';

/**
 * Zod contracts for every LLM exchange in the writing coach.
 *
 * Each response is validated before it reaches the database or the user, so a
 * model that drifts off-format degrades to a caught error rather than writing
 * malformed state into the rolling memory.
 */

/**
 * The model sometimes wraps its one object in an array: seen twice in a row
 * from gemma-4 on the rubric prompt. Same answer, so it is unwrapped rather
 * than costing the learner their feedback.
 */
const unwrapSingle = (value: unknown): unknown =>
  Array.isArray(value) && value.length === 1 ? (value[0] as unknown) : value;

export const sampleSchema = z.preprocess(
  unwrapSingle,
  z.object({
    text: z.string().min(20),
  }),
);
export type SampleResult = z.infer<typeof sampleSchema>;

/**
 * What a paragraph is scored on, each from 1 to 10, in display order.
 *
 * The overall score is computed from these rather than asked for. A single
 * holistic number could not be explained to the learner, and the model treated
 * 10 as unreachable however clean the paragraph was.
 */
export const CRITERIA = ['targetWords', 'grammar', 'range', 'cohesion'] as const;
export type Criterion = (typeof CRITERIA)[number];
export type CriterionScores = Record<Criterion, number>;

/** A string "7" or a 7.5 is the same judgement; a 0 copied from the shape is not. */
const criterionScore = z.coerce.number().min(1).max(10).transform(Math.round);

/**
 * The mean of the criteria, rounded: every criterion weighs the same. A 10
 * means nothing to correct, so a mean of 9.5 stays a 9.
 */
export function overallScore(scores: CriterionScores): number {
  const mean = CRITERIA.reduce((sum, criterion) => sum + scores[criterion], 0) / CRITERIA.length;
  return mean === 10 ? 10 : Math.min(9, Math.round(mean));
}

export const feedbackSchema = z.preprocess(
  unwrapSingle,
  z
    .object({
      overallComment: z.string().min(1),
      vocabularyUsed: z.array(z.string()).max(20),
      vocabularyMissing: z.array(z.string()).max(20),
      grammarIssues: z.array(z.string()).max(5),
      suggestions: z.array(z.string()).max(5),
      scores: z.object({
        targetWords: criterionScore,
        grammar: criterionScore,
        range: criterionScore,
        cohesion: criterionScore,
      }),
      correctedText: z.string().min(1),
    })
    .transform((feedback) => ({ ...feedback, score: overallScore(feedback.scores) })),
);
export type WritingFeedback = z.infer<typeof feedbackSchema>;

export const summarySchema = z.preprocess(
  unwrapSingle,
  z.object({
    /** Recurring patterns, capped so the memory stays a summary and not a log. */
    grammarPatterns: z.array(z.string()).max(5),
    missedVocabulary: z.array(z.string()).max(10),
    lastSessionNote: z.string().min(1),
  }),
);
export type SummaryUpdate = z.infer<typeof summarySchema>;

export const MIN_WORDS = 30;
export const MAX_WORDS = 300;

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

export type LengthVerdict = 'ok' | 'too-short' | 'too-long';

/** Bound the submission: too short teaches nothing, too long burns context. */
export function checkLength(text: string): { verdict: LengthVerdict; words: number } {
  const words = countWords(text);
  if (words < MIN_WORDS) return { verdict: 'too-short', words };
  if (words > MAX_WORDS) return { verdict: 'too-long', words };
  return { verdict: 'ok', words };
}
