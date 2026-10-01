import { describe, expect, it } from 'vitest';
import {
  checkLength,
  countWords,
  feedbackSchema,
  MAX_WORDS,
  MIN_WORDS,
  overallScore,
} from './contracts.js';
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

  it('asks for a score per criterion, not one overall number', () => {
    const prompt = joined(buildFeedbackPrompt({ lemmas: LEMMAS, text: STUDENT_TEXT }));
    for (const criterion of ['targetWords', 'grammar', 'range', 'cohesion']) {
      expect(prompt).toContain(criterion);
    }
    expect(prompt).not.toContain('"score"');
  });

  /** A teacher found the old rubric never gave 10, and no score could be explained. */
  it('gives 10 when nothing can be pointed to, and ties every lost point to an issue', () => {
    const prompt = joined(buildFeedbackPrompt({ lemmas: LEMMAS, text: STUDENT_TEXT }));
    expect(prompt).toContain('Give 10 whenever you cannot point to a specific problem');
    expect(prompt).toContain('must be explained by at least one item');
    expect(prompt).toContain('1–2');
  });
});

describe('feedbackSchema', () => {
  const answer = (scores: Record<string, unknown>) => ({
    overallComment: 'Good effort',
    scores,
    vocabularyUsed: ['medicine'],
    vocabularyMissing: [],
    grammarIssues: [],
    suggestions: [],
    correctedText: 'corrected',
  });

  it('computes the overall score as the rounded mean of the criteria', () => {
    const parsed = feedbackSchema.parse(answer({ targetWords: 8, grammar: 6, range: 7, cohesion: 8 }));
    expect(parsed.score).toBe(7);
    expect(parsed.scores).toEqual({ targetWords: 8, grammar: 6, range: 7, cohesion: 8 });
  });

  it('gives a 10 overall only when every criterion is a 10', () => {
    expect(overallScore({ targetWords: 10, grammar: 10, range: 10, cohesion: 10 })).toBe(10);
    expect(overallScore({ targetWords: 10, grammar: 10, range: 10, cohesion: 9 })).toBe(9);
    expect(overallScore({ targetWords: 10, grammar: 10, range: 9, cohesion: 8 })).toBe(9);
    expect(overallScore({ targetWords: 6, grammar: 5, range: 6, cohesion: 5 })).toBe(6);
  });

  it('accepts a score sent as a string or with a fraction', () => {
    const parsed = feedbackSchema.parse(
      answer({ targetWords: '9', grammar: 7.5, range: 7, cohesion: 7 }),
    );
    expect(parsed.scores.targetWords).toBe(9);
    expect(parsed.scores.grammar).toBe(8);
  });

  it('unwraps an answer the model put inside a one-item array', () => {
    const parsed = feedbackSchema.parse([
      answer({ targetWords: 10, grammar: 10, range: 10, cohesion: 10 }),
    ]);
    expect(parsed.score).toBe(10);
  });

  /** The JSON shape shows 0s: a model that copies them must fail, not score 0. */
  it('rejects the 0 placeholder and anything out of range', () => {
    expect(() =>
      feedbackSchema.parse(answer({ targetWords: 0, grammar: 0, range: 0, cohesion: 0 })),
    ).toThrow();
    expect(() =>
      feedbackSchema.parse(answer({ targetWords: 11, grammar: 7, range: 7, cohesion: 7 })),
    ).toThrow();
    expect(() => feedbackSchema.parse(answer({ targetWords: 7, grammar: 7, range: 7 }))).toThrow();
  });
});

describe('buildSummaryPrompt', () => {
  const feedback = {
    overallComment: 'Good effort',
    vocabularyUsed: ['medicine', 'child'],
    vocabularyMissing: ['energy'],
    grammarIssues: ['"I go" should be "I went"'],
    suggestions: ['Vary sentence length'],
    scores: { targetWords: 8, grammar: 5, range: 6, cohesion: 6 },
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
