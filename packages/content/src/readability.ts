import type { Lexicon } from '@ngsl/media';

/**
 * Rank corpus sentences as teaching examples.
 *
 * This is a different question from the clip quality score. That one asked "is
 * this watchable?" — pace, duration, completeness. This one asks "can a learner
 * who knows roughly this much English *read* it?", which is a lexical question.
 *
 * The dominant signal is **lexical coverage**: what share of the sentence the
 * learner plausibly already knows. An example is useless if understanding it
 * requires three words harder than the one being taught. Because the vocabulary
 * is closed and bucketed by frequency, that is directly computable rather than
 * approximated by a syllable-counting formula like Flesch.
 */

export interface ReadabilityContext {
  lexicon: Lexicon;
  /** wordId → frequency bucket, 1 (most frequent) … 10. */
  buckets: Map<number, number>;
}

export interface ReadabilityBreakdown {
  score: number;
  coverage: number;
  hardWordCount: number;
  wordCount: number;
  containsTarget: boolean;
}

const IDEAL_MIN_WORDS = 6;
const IDEAL_MAX_WORDS = 18;

const TOKEN = /[a-z][a-z']*/g;

/**
 * A sentence opening on one of these is a continuation of something the learner
 * cannot see, so it reads as a fragment however grammatical it is.
 */
const DANGLING_OPENER =
  /^(and|but|or|so|because|which|that|then|also|however|therefore|thus|yet|still)\b/i;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function scoreReadability(
  text: string,
  targetWordId: number,
  context: ReadabilityContext,
): ReadabilityBreakdown {
  const { lexicon, buckets } = context;
  const trimmed = text.trim();
  const tokens = trimmed.toLowerCase().match(TOKEN) ?? [];
  const wordCount = tokens.length;

  if (wordCount === 0) {
    return { score: 0, coverage: 0, hardWordCount: 0, wordCount: 0, containsTarget: false };
  }

  const targetBucket = buckets.get(targetWordId) ?? 10;

  let known = 0;
  let hardWordCount = 0;
  let containsTarget = false;

  for (const token of tokens) {
    const id = lexicon.resolve(token);
    if (id === undefined) continue;
    known += 1;
    if (id === targetWordId) {
      containsTarget = true;
      continue;
    }
    // "Harder than the word being taught" is the thing that makes an example
    // unusable, so rarity is measured relative to the target, not absolutely.
    if ((buckets.get(id) ?? 10) > targetBucket) hardWordCount += 1;
  }

  const coverage = known / wordCount;
  const easiness = 1 - hardWordCount / wordCount;

  const lengthScore =
    wordCount >= IDEAL_MIN_WORDS && wordCount <= IDEAL_MAX_WORDS
      ? 1
      : clamp01(
          1 -
            (wordCount < IDEAL_MIN_WORDS ? IDEAL_MIN_WORDS - wordCount : wordCount - IDEAL_MAX_WORDS) /
              12,
        );

  const complete = /[.!?…]["'”’)\]]*$/.test(trimmed) && /^["'“‘(]?[A-Z]/.test(trimmed) ? 1 : 0;
  const standalone = DANGLING_OPENER.test(trimmed) ? 0 : 1;

  const score = clamp01(
    0.35 * coverage + 0.25 * easiness + 0.2 * lengthScore + 0.1 * complete + 0.1 * standalone,
  );

  // An example that does not contain the word it illustrates is worthless,
  // whatever else it scores.
  return {
    score: containsTarget ? score : 0,
    coverage,
    hardWordCount,
    wordCount,
    containsTarget,
  };
}
