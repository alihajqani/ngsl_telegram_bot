import type { ChatMessage } from '@ngsl/llm';
import type { WritingFeedback } from './contracts.js';

/**
 * Prompt construction.
 *
 * The load-bearing property of this file is what each prompt is NOT given.
 * `buildSamplePrompt` never receives the student's text — see below.
 */

/**
 * Call A — the independent native sample.
 *
 * This takes ONLY the word list. That is the entire point of splitting the two
 * calls: a model that has just read the student's paragraph anchors on their
 * structure, vocabulary and topic, and the "compare your writing with a native
 * version" exercise collapses into a lightly-edited echo of what they wrote.
 * The signature makes that mistake impossible rather than relying on a comment.
 */
export function buildSamplePrompt(lemmas: readonly string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a native English writer producing model paragraphs for language ' +
        'learners. Reply with JSON only — no prose, no markdown.',
    },
    {
      role: 'user',
      content:
        `Write one natural English paragraph that uses all of these words: ${lemmas.join(', ')}.\n\n` +
        'Rules:\n' +
        '- 60 to 110 words, a single coherent paragraph.\n' +
        '- Natural, idiomatic, native-level register — not simplified.\n' +
        '- Use every word listed, in any inflection.\n' +
        '- Pick any everyday topic that lets the words fit together comfortably.\n\n' +
        'JSON shape: {"text":"..."}',
    },
  ];
}

export interface FeedbackContext {
  lemmas: readonly string[];
  text: string;
  /** Recurring issues from previous sessions, so feedback compounds. */
  priorPatterns?: readonly string[];
}

/**
 * The scoring rubric: four criteria modelled on the IELTS writing bands, one
 * scale for all of them, pitched at a short everyday paragraph.
 *
 * Two lines carry the fixes for what a teacher using the bot found: a 10 is
 * given whenever nothing can be pointed to, and every lost point is backed by
 * a listed issue, so the score can be explained.
 */
const RUBRIC =
  'Score the paragraph from 1 to 10 on each of these four criteria, separately:\n' +
  '- targetWords: each target word is used with the right meaning, form and part of ' +
  'speech, inside a grammatical sentence. A word dropped into a broken phrase ' +
  '("decide future good") counts as misused. Each target word that is missing or ' +
  'misused costs about 2 points.\n' +
  '- grammar: accuracy — verb tenses, agreement, articles, prepositions, word order, ' +
  'spelling and punctuation.\n' +
  '- range: variety and precision — compound and complex sentences, varied structures, ' +
  'precise word choice beyond the most basic words.\n' +
  '- cohesion: the ideas follow logically and are joined with suitable linkers ' +
  '(because, however, although, so, then, first ...).\n\n' +
  'Use the same scale for every criterion:\n' +
  '- 10: nothing to correct or improve. Give 10 whenever you cannot point to a ' +
  'specific problem; it is not reserved for an ideal text.\n' +
  '- 9: a single tiny slip, otherwise excellent.\n' +
  '- 7–8: good, with a few minor errors that never affect the meaning.\n' +
  '- 5–6: competent, with several errors, but the meaning is always clear.\n' +
  '- 3–4: frequent errors that sometimes make the meaning unclear.\n' +
  '- 1–2: hard to understand, or the criterion is almost entirely unmet.\n\n' +
  'Judge it as a short paragraph of everyday English, not an academic essay: a high ' +
  'score needs no academic vocabulary or essay structure. Every criterion below 10 ' +
  'must be explained by at least one item in grammarIssues or suggestions.';

/** Call B — grade and correct the student's submission. */
export function buildFeedbackPrompt(context: FeedbackContext): ChatMessage[] {
  const history =
    context.priorPatterns && context.priorPatterns.length > 0
      ? `\nThis learner has previously struggled with:\n${context.priorPatterns
          .map((p) => `- ${p}`)
          .join('\n')}\nMention progress on these if it is visible.\n`
      : '';

  return [
    {
      role: 'system',
      content:
        'You are an experienced English writing teacher and examiner. Your scores are ' +
        'strict and consistent; your comments are encouraging, concise and specific. ' +
        'Reply with JSON only — no prose, no markdown.',
    },
    {
      role: 'user',
      content:
        `The learner was asked to write using these target words: ${context.lemmas.join(', ')}\n` +
        history +
        `\nTheir paragraph:\n"""\n${context.text}\n"""\n\n` +
        RUBRIC +
        '\n\nJSON shape (replace each 0 in "scores" with your score):\n' +
        '{"overallComment":"one or two encouraging sentences",' +
        '"scores":{"targetWords":0,"grammar":0,"range":0,"cohesion":0},' +
        '"vocabularyUsed":["target words actually used"],' +
        '"vocabularyMissing":["target words not used"],' +
        '"grammarIssues":["at most 5 specific issues, each quoting the phrase"],' +
        '"suggestions":["at most 5 concrete improvements"],' +
        '"correctedText":"the full paragraph with grammar, spelling and punctuation ' +
        'fixed — preserve the learner\'s meaning, vocabulary choices and structure"}',
    },
  ];
}

export interface SummaryContext {
  feedback: WritingFeedback;
  prior?: {
    grammarPatterns: string[];
    missedVocabulary: string[];
  };
}

/**
 * Call C — fold this session into the learner's rolling memory.
 *
 * Deliberately a merge rather than an append: the value of the memory is that
 * it surfaces *recurring* problems, which means it has to forget one-off slips.
 */
export function buildSummaryPrompt(context: SummaryContext): ChatMessage[] {
  const prior = context.prior;
  const priorBlock = prior
    ? `Existing summary:\n` +
      `- recurring grammar patterns: ${prior.grammarPatterns.join('; ') || 'none yet'}\n` +
      `- frequently skipped words: ${prior.missedVocabulary.join(', ') || 'none yet'}\n`
    : 'There is no existing summary; this is the learner\'s first session.\n';

  return [
    {
      role: 'system',
      content:
        'You maintain a compact, evolving profile of an English learner\'s recurring ' +
        'writing weaknesses. Reply with JSON only — no prose, no markdown.',
    },
    {
      role: 'user',
      content:
        priorBlock +
        `\nThis session's findings:\n` +
        `- grammar issues: ${context.feedback.grammarIssues.join('; ') || 'none'}\n` +
        `- target words not used: ${context.feedback.vocabularyMissing.join(', ') || 'none'}\n` +
        `- score: ${context.feedback.score}/10\n\n` +
        'Merge the new findings into the existing summary.\n' +
        'Rules:\n' +
        '- Keep at most 5 grammar patterns: the ones that RECUR, not one-off slips.\n' +
        '- Drop anything the learner appears to have fixed.\n' +
        '- Keep at most 10 frequently skipped words.\n' +
        '- "lastSessionNote" is one short encouraging sentence about this session.\n\n' +
        'JSON shape: {"grammarPatterns":["..."],"missedVocabulary":["..."],' +
        '"lastSessionNote":"..."}',
    },
  ];
}
