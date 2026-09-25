import type * as grammy from 'grammy';
import { GrammyError } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Bulk sends: a blocked user is flagged, and flood control is waited out, not lost. */

const sendMessage = vi.fn();
const flagBlocked = vi.fn(() => Promise.resolve());

vi.mock('grammy', async (importOriginal) => ({
  ...(await importOriginal<typeof grammy>()),
  Bot: class {
    api = { sendMessage };
  },
}));
vi.mock('@ngsl/db', () => ({ flagBlocked }));
vi.mock('@ngsl/shared', () => ({
  config: () => ({ telegram: { botToken: 'token' } }),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { deliver } = await import('./dispatch.js');

const target = { userId: 1, telegramId: 100 };
const telegramError = (code: number, retryAfter?: number) =>
  new GrammyError(
    'Call to sendMessage failed',
    {
      ok: false,
      error_code: code,
      description: 'error',
      parameters: retryAfter === undefined ? {} : { retry_after: retryAfter },
    },
    'sendMessage',
    {},
  );

beforeEach(() => {
  sendMessage.mockReset();
  flagBlocked.mockClear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('deliver', () => {
  it('waits out flood control and sends once more', async () => {
    sendMessage.mockRejectedValueOnce(telegramError(429, 3)).mockResolvedValueOnce({});

    const delivery = deliver(target, 'hi');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await delivery).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('flags a user who blocked the bot', async () => {
    sendMessage.mockRejectedValueOnce(telegramError(403));
    expect(await deliver(target, 'hi')).toBe(false);
    expect(flagBlocked).toHaveBeenCalledWith(100);
  });
});
