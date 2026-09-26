import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type * as Provider from './provider.js';

const complete = vi.fn();

vi.mock('@ngsl/shared', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('./provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Provider>()),
  complete,
}));

const { completeJson } = await import('./json.js');
const { AllKeysExhaustedError, LlmIncompleteError } = await import('./provider.js');

const schema = z.object({ a: z.number() });

beforeEach(() => {
  complete.mockReset();
});

describe('completeJson', () => {
  it('retries an answer that came back empty or cut off', async () => {
    complete
      .mockRejectedValueOnce(new LlmIncompleteError('Gemini returned no answer'))
      .mockResolvedValueOnce('{"a":1}');

    await expect(completeJson([], schema)).resolves.toEqual({ a: 1 });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('reports the incomplete answer itself when every attempt is incomplete', async () => {
    complete.mockRejectedValue(new LlmIncompleteError('Gemini returned no answer (MAX_TOKENS)'));

    await expect(completeJson([], schema)).rejects.toThrow(
      'Gemini returned no answer (MAX_TOKENS)',
    );
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('does not retry when every key is rate limited', async () => {
    complete.mockRejectedValue(new AllKeysExhaustedError('gemini'));

    await expect(completeJson([], schema)).rejects.toBeInstanceOf(AllKeysExhaustedError);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
