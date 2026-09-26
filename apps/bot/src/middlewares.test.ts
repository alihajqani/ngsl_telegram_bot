import { Context, type Api } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotContext, SessionData } from './types.js';

/** A learner's first update is reported to the monitor's users topic, once. */

const upsertUser = vi.fn();
const countUsers = vi.fn(() => Promise.resolve(120));
const reportUserJoined = vi.fn();

vi.mock('@ngsl/db', () => ({ upsertUser, countUsers, touchActivity: vi.fn() }));
vi.mock('@ngsl/monitor', () => ({ reportUserJoined }));
vi.mock('@ngsl/shared', () => ({
  config: () => ({ telegram: {} }),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { localeContext } = await import('./middlewares.js');

const me = { id: 1, is_bot: true, first_name: 'bot', username: 'bot' } as UserFromGetMe;
const from = { id: 42, is_bot: false, first_name: 'Sara', username: 'sara' };
const stored = { id: 5, telegramId: 42, locale: 'fa', firstName: 'Sara' };
const update: Update = {
  update_id: 1,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 42, type: 'private', first_name: 'Sara' },
    from,
    text: '/start',
  },
};

async function run(session: Partial<SessionData>): Promise<void> {
  const ctx = new Context(update, {} as Api, me) as BotContext;
  ctx.session = { reviewQueue: [], reviewAnswered: 0, ...session };
  await localeContext(ctx, () => Promise.resolve());
  // The report is posted off the update's path; let it settle.
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  upsertUser.mockReset();
  reportUserJoined.mockReset();
});

describe('localeContext', () => {
  it('reports a user the upsert created, with the new user count', async () => {
    upsertUser.mockResolvedValue({ ...stored, created: true });

    await run({});

    expect(reportUserJoined).toHaveBeenCalledWith(from, 120);
  });

  it('does not report a user who already existed', async () => {
    upsertUser.mockResolvedValue({ ...stored, created: false });

    await run({});

    expect(reportUserJoined).not.toHaveBeenCalled();
  });

  it('does not touch the database for a user already in session', async () => {
    await run({ userId: 5, locale: 'fa' });

    expect(upsertUser).not.toHaveBeenCalled();
    expect(reportUserJoined).not.toHaveBeenCalled();
  });
});
