import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Monitor from './monitor.js';

/**
 * The monitor is a logging transport: the only behaviour that really matters is
 * that it can never take the process down, whatever Telegram answers.
 */

const fetchMock = vi.fn();

vi.mock('@ngsl/shared', () => ({
  config: () => ({
    telegram: { botToken: 'token' },
    monitor: { groupId: -100, threads: { technical: 1, users: 2, features: 3, summary: 4 } },
  }),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  serializeError: (error: unknown) => ({ message: String(error) }),
  proxyFetch: (...args: unknown[]) => fetchMock(...args) as unknown,
}));

async function loadMonitor() {
  vi.resetModules();
  return import('./monitor.js');
}

const ok = () => ({ ok: true, status: 200, text: () => Promise.resolve('') });
const rejected = (status: number, body: string) => ({
  ok: false,
  status,
  text: () => Promise.resolve(body),
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('monitor delivery', () => {
  it('sends a queued message on the drain tick', async () => {
    const { post } = await loadMonitor();
    fetchMock.mockResolvedValue(ok());

    post('technical', 'hello');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/bottoken/sendMessage');
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: -100, message_thread_id: 1 });
  });

  it('survives a network failure and backs off instead of hammering', async () => {
    const { post, isMonitorEnabled } = await loadMonitor();
    fetchMock.mockRejectedValue(new Error('fetch failed'));

    post('technical', 'hello');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Backoff holds the next attempt back; the message is not lost.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isMonitorEnabled()).toBe(true);

    fetchMock.mockResolvedValue(ok());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('switches itself off when the destination is unusable', async () => {
    const { post, isMonitorEnabled } = await loadMonitor();
    fetchMock.mockResolvedValue(rejected(400, '{"description":"Bad Request: chat not found"}'));

    post('technical', 'hello');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(isMonitorEnabled()).toBe(false);

    post('technical', 'again');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops one malformed message without disabling the monitor', async () => {
    const { post, isMonitorEnabled } = await loadMonitor();
    fetchMock.mockResolvedValue(rejected(400, '{"description":"Bad Request: message is empty"}'));

    post('technical', 'hello');
    await vi.advanceTimersByTimeAsync(1_500);

    expect(isMonitorEnabled()).toBe(true);
    fetchMock.mockResolvedValue(ok());
    post('technical', 'second');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops flushing at shutdown once the API stops answering', async () => {
    const { post, flushMonitor } = await loadMonitor();
    fetchMock.mockRejectedValue(new Error('fetch failed'));

    post('technical', 'one');
    post('users', 'two');
    post('features', 'three');

    await flushMonitor();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('user and feature events', () => {
  const sara = { id: 42, first_name: 'Sara <3', username: 'sara' };

  async function sentAfter(emit: (monitor: typeof Monitor) => void) {
    const monitor = await loadMonitor();
    fetchMock.mockResolvedValue(ok());
    emit(monitor);
    await vi.advanceTimersByTimeAsync(1_500);
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    return JSON.parse(init.body) as { message_thread_id: number; text: string };
  }

  it('posts a new user to the users topic with their handle, id and the new total', async () => {
    const body = await sentAfter(({ reportUserJoined }) => reportUserJoined(sara, 120));

    expect(body.message_thread_id).toBe(2);
    expect(body.text).toBe('👤 <b>Sara &lt;3</b> @sara joined\n<code>42</code> · 120 users');
  });

  it('posts a feature use to the features topic with its detail', async () => {
    const body = await sentAfter(({ reportFeature }) =>
      reportFeature('writing', { id: 7, first_name: 'Ali' }, '64 words · score 7'),
    );

    expect(body.message_thread_id).toBe(3);
    expect(body.text).toBe('✍️ <b>Ali</b> · Writing\n<code>7</code> · 64 words · score 7');
  });

  it('escapes what the learner typed', async () => {
    const body = await sentAfter(({ reportFeature }) => reportFeature('search', sara, '<b>x</b>'));

    expect(body.text).toBe(
      '🔎 <b>Sara &lt;3</b> @sara · Search\n<code>42</code> · &lt;b&gt;x&lt;/b&gt;',
    );
  });
});
