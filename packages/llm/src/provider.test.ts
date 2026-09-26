import { describe, expect, it } from 'vitest';
import { geminiAnswerText, geminiIncomplete, withServerRetry } from './provider.js';

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

describe('withServerRetry', () => {
  const statuses = (...list: number[]) => {
    const calls: number[] = [];
    const fn = () => {
      const status = list[calls.length] ?? 200;
      calls.push(status);
      return Promise.resolve({ status });
    };
    return { fn, calls };
  };

  it('retries a server error and returns the first good response', async () => {
    const { fn, calls } = statuses(500, 503, 200);
    const response = await withServerRetry(fn, [0, 0]);
    expect(response.status).toBe(200);
    expect(calls).toEqual([500, 503, 200]);
  });

  it('gives up after the last delay and returns the error response', async () => {
    const { fn, calls } = statuses(500, 500, 500, 200);
    expect((await withServerRetry(fn, [0, 0])).status).toBe(500);
    expect(calls).toHaveLength(3);
  });

  it('does not retry a client error or a rate limit', async () => {
    for (const status of [400, 429]) {
      const { fn, calls } = statuses(status);
      expect((await withServerRetry(fn, [0, 0])).status).toBe(status);
      expect(calls).toHaveLength(1);
    }
  });
});

describe('geminiIncomplete', () => {
  const answer = (text: string, finishReason: string) => ({
    candidates: [
      { finishReason, content: { parts: [{ thought: true, text: 'thinking' }, { text }] } },
    ],
    usageMetadata: { thoughtsTokenCount: 8000, candidatesTokenCount: 192 },
  });

  it('accepts an answer that finished normally', () => {
    const payload = answer('{"a":1}', 'STOP');
    expect(geminiIncomplete(payload, geminiAnswerText(payload))).toBeUndefined();
  });

  it('names the finish reason and token counts of an empty answer', () => {
    const payload = answer('', 'MAX_TOKENS');
    expect(geminiIncomplete(payload, geminiAnswerText(payload))).toBe(
      'no answer (finishReason MAX_TOKENS, thoughtsTokenCount 8000, candidatesTokenCount 192)',
    );
  });

  it('rejects an answer cut off at the token limit even when it has text', () => {
    const payload = answer('{"words":[{"word":"law"', 'MAX_TOKENS');
    expect(geminiIncomplete(payload, geminiAnswerText(payload))).toMatch(
      /^answer cut off \(finishReason MAX_TOKENS/,
    );
  });
});
