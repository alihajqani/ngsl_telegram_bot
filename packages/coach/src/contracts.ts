import { z } from 'zod';

/**
 * Zod contracts for every LLM exchange in the writing coach.
 *
 * Each response is validated before it reaches the database or the user, so a
 * model that drifts off-format degrades to a caught error rather than writing
 * malformed state into the rolling memory.
 */

export const sampleSchema = z.object({
  text: z.string().min(20),
});
export type SampleResult = z.infer<typeof sampleSchema>;

export const feedbackSchema = z.object({
  overallComment: z.string().min(1),
  vocabularyUsed: z.array(z.string()).max(20),
  vocabularyMissing: z.array(z.string()).max(20),
  grammarIssues: z.array(z.string()).max(5),
  suggestions: z.array(z.string()).max(5),
  score: z.number().int().min(1).max(10),
  correctedText: z.string().min(1),
});
export type WritingFeedback = z.infer<typeof feedbackSchema>;

export const summarySchema = z.object({
  /** Recurring patterns, capped so the memory stays a summary and not a log. */
  grammarPatterns: z.array(z.string()).max(5),
  missedVocabulary: z.array(z.string()).max(10),
  lastSessionNote: z.string().min(1),
});
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
