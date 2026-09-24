import { describe, expect, it } from 'vitest';
import { geminiAnswerText } from './provider.js';

describe('geminiAnswerText', () => {
  it('keeps only the answer, dropping the reasoning of a thinking model', () => {
    // Shape observed from gemma-4 on the Gemini API: the reasoning comes back as
    // parts flagged `thought: true`, and it contains a draft of the JSON.
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: 'JSON structure: {"words":[{"word":"...","phrases":[]}]}' },
              { thought: true, text: '`' },
              { text: '{"words":[{"word":"apple","phrases":[]}]}' },
            ],
          },
        },
      ],
    };
    expect(geminiAnswerText(payload)).toBe('{"words":[{"word":"apple","phrases":[]}]}');
  });

  it('joins a multi-part answer from a model that does not think', () => {
    const payload = { candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }] };
    expect(geminiAnswerText(payload)).toBe('{"a":1}');
  });

  it('returns an empty string when there is no candidate', () => {
    expect(geminiAnswerText({})).toBe('');
  });
});
