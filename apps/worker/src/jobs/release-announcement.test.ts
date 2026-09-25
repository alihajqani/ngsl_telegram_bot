import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * After every deploy of a new version, each learner is told once, in their own
 * language, which version it is and to tap /start. A worker restarted midway
 * picks up after the last learner reached.
 */

const store = new Map<string, string>();
const redis = {
  get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
  set: vi.fn((key: string, value: string) => {
    store.set(key, value);
    return Promise.resolve('OK');
  }),
  del: vi.fn((key: string) => Promise.resolve(store.delete(key) ? 1 : 0)),
};
const deliver = vi.fn((_target: unknown, _text: string) => Promise.resolve(true));
const audience = [
  { userId: 3, telegramId: 300, locale: 'en' as const },
  { userId: 1, telegramId: 100, locale: 'fa' as const },
  { userId: 2, telegramId: 200, locale: 'fa' as const },
];

vi.mock('@ngsl/db', () => ({ broadcastAudience: () => Promise.resolve(audience) }));
vi.mock('@ngsl/queue', () => ({ redisClient: () => redis }));
vi.mock('@ngsl/shared', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('./dispatch.js', () => ({ deliver }));

const { announceRelease, appVersion } = await import('./release-announcement.js');

const noWait = () => Promise.resolve();
const recipients = () => deliver.mock.calls.map(([target]) => (target as { telegramId: number }).telegramId);

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('announceRelease', () => {
  it('tells every learner the version and to tap /start, in their language', async () => {
    const result = await announceRelease('3.3.0', noWait);

    expect(result).toEqual({ sent: 3, skipped: false });
    expect(recipients()).toEqual([100, 200, 300]);
    const [fa, , en] = deliver.mock.calls.map(([, text]) => text);
    expect(fa).toContain('3.3.0');
    expect(fa).toContain('/start');
    expect(fa).toContain('نسخه');
    expect(en).toContain('3.3.0');
    expect(en).toContain('/start');
    expect(en).toContain('version');
  });

  it('announces a version once, however often the worker restarts', async () => {
    await announceRelease('3.3.0', noWait);
    deliver.mockClear();

    expect(await announceRelease('3.3.0', noWait)).toEqual({ sent: 0, skipped: true });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('announces the next version again', async () => {
    await announceRelease('3.3.0', noWait);
    deliver.mockClear();

    await announceRelease('3.4.0', noWait);
    expect(recipients()).toEqual([100, 200, 300]);
  });

  it('resumes after the last learner reached when a run was cut short', async () => {
    deliver.mockImplementationOnce(() => Promise.resolve(true));
    deliver.mockImplementationOnce(() => Promise.reject(new Error('worker stopped')));
    await expect(announceRelease('3.3.0', noWait)).rejects.toThrow('worker stopped');
    deliver.mockClear();

    await announceRelease('3.3.0', noWait);
    expect(recipients()).toEqual([200, 300]);
  });

  it('waits between messages', async () => {
    const wait = vi.fn(() => Promise.resolve());
    await announceRelease('3.3.0', wait);
    expect(wait).toHaveBeenCalledTimes(3);
  });
});

describe('appVersion', () => {
  it('is the version in the worker package', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(await appVersion()).toBe(pkg.version);
  });
});
