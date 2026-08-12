import { describe, expect, it } from 'vitest';
import { checkLength, countWords, MAX_WORDS, MIN_WORDS } from './contracts.js';
import { buildFeedbackPrompt, buildSamplePrompt, buildSummaryPrompt } from './prompts.js';

const LEMMAS = ['medicine', 'child', 'question', 'energy', 'light'];

const STUDENT_TEXT =
  'Yesterday I go to the hospital because my child was very sick and needed medicine. ' +
  'The doctor ask me many question about the energy of my child and I answer them all.';

const joined = (messages: { content: string }[]) => messages.map((m) => m.content).join('\n');

describe('buildSamplePrompt', () => {
  it('includes every target word', () => {
    const prompt = joined(buildSamplePrompt(LEMMAS));
    for (const lemma of LEMMAS) expect(prompt).toContain(lemma);
  });

  /**
   * The whole reason for two separate calls. If the sample generator sees the
   * student's paragraph it anchors on their topic and phrasing, and "compare
   * your writing with a native version" becomes a lightly-edited echo.
   */
  it('cannot receive the student text — the signature only accepts lemmas', () => {
    const prompt = joined(buildSamplePrompt(LEMMAS));
    expect(prompt).not.toContain('hospital');
    expect(prompt).not.toContain(STUDENT_TEXT);
    expect(prompt.toLowerCase()).not.toContain('learner wrote');
  });

  it('asks for JSON and a native register', () => {
    const prompt = joined(buildSamplePrompt(LEMMAS));
    expect(prompt).toContain('JSON');
    expect(prompt.toLowerCase()).toContain('native');
  });
});

describe('buildFeedbackPrompt', () => {
  it('includes the student text and the target words', () => {
    const prompt = joined(buildFeedbackPrompt({ lemmas: LEMMAS, text: STUDENT_TEXT }));
    expect(prompt).toContain(STUDENT_TEXT);
    expect(prompt).toContain('medicine');
  });

  it('carries prior weaknesses forward when there is a history', () => {
    const prompt = joined(
      buildFeedbackPrompt({
        lemmas: LEMMAS,
        text: STUDENT_TEXT,
        priorPatterns: ['past tense of irregular verbs', 'article omission'],
      }),
    );
    expect(prompt).toContain('past tense of irregular verbs');
    expect(prompt).toContain('article omission');
  });

  it('omits the history block entirely for a first session', () => {
    const prompt = joined(buildFeedbackPrompt({ lemmas: LEMMAS, text: STUDENT_TEXT }));
    expect(prompt).not.toContain('previously struggled');
  });

  it('specifies the scoring rubric so scores stay comparable across sessions', () => {
    const prompt = joined(buildFeedbackPrompt({ lemmas: LEMMAS, text: STUDENT_TEXT }));
    expect(prompt).toContain('5–6');
    expect(prompt).toContain('correctedText');
  });
});

describe('buildSummaryPrompt', () => {
  const feedback = {
    overallComment: 'Good effort',
    vocabularyUsed: ['medicine', 'child'],
    vocabularyMissing: ['energy'],
    grammarIssues: ['"I go" should be "I went"'],
    suggestions: ['Vary sentence length'],
    score: 6,
    correctedText: 'corrected',
  };

  it('includes this session’s findings', () => {
    const prompt = joined(buildSummaryPrompt({ feedback }));
    expect(prompt).toContain('I went');
    expect(prompt).toContain('energy');
  });

  it('states it is a first session when there is no prior summary', () => {
    expect(joined(buildSummaryPrompt({ feedback }))).toContain('first session');
  });

  it('feeds the prior summary back in so the memory merges rather than resets', () => {
    const prompt = joined(
      buildSummaryPrompt({
        feedback,
        prior: { grammarPatterns: ['article omission'], missedVocabulary: ['light'] },
      }),
    );
    expect(prompt).toContain('article omission');
    expect(prompt).toContain('light');
    expect(prompt).toContain('RECUR');
  });
});

describe('checkLength', () => {
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');

  it('accepts a paragraph in range', () => {
    expect(checkLength(words(100))).toEqual({ verdict: 'ok', words: 100 });
  });

  it('rejects anything under the minimum', () => {
    expect(checkLength(words(MIN_WORDS - 1)).verdict).toBe('too-short');
  });

  it('rejects anything over the maximum', () => {
    expect(checkLength(words(MAX_WORDS + 1)).verdict).toBe('too-long');
  });

  it('treats the bounds themselves as valid', () => {
    expect(checkLength(words(MIN_WORDS)).verdict).toBe('ok');
    expect(checkLength(words(MAX_WORDS)).verdict).toBe('ok');
  });

  it('counts words across newlines and repeated spaces', () => {
    expect(countWords('one   two\n\nthree ')).toBe(3);
    expect(countWords('   ')).toBe(0);
  });
});
