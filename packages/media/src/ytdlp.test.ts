import { describe, expect, it } from 'vitest';
import { buildBaseArgs, classifyError } from './ytdlp.js';

describe('classifyError', () => {
  it('recognises the bot wall, including the session rate limit', () => {
    expect(classifyError("Sign in to confirm you're not a bot")).toBe('bot-wall');
    expect(classifyError('HTTP Error 429: Too Many Requests')).toBe('bot-wall');
    expect(
      classifyError(
        "This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour.",
      ),
    ).toBe('bot-wall');
  });

  it('separates dead sources from transient failures', () => {
    expect(classifyError('ERROR: Video unavailable')).toBe('dead');
    expect(classifyError('Connection reset by peer')).toBe('transient');
  });
});

describe('buildBaseArgs', () => {
  it('always enables the JavaScript runtime that solves player challenges', () => {
    const args = buildBaseArgs({ jsRuntime: 'node' });
    expect(args.join(' ')).toContain('--js-runtimes node');
  });

  it('passes the writable cookie copy, never the mounted original', () => {
    const args = buildBaseArgs({ jsRuntime: 'node', cookiesPath: '/tmp/ngsl-clips/yt-cookies-1.txt' });
    expect(args.join(' ')).toContain('--cookies /tmp/ngsl-clips/yt-cookies-1.txt');
    expect(buildBaseArgs({ jsRuntime: 'node' })).not.toContain('--cookies');
  });

  it('adds the proxy and extractor arguments only when configured', () => {
    const args = buildBaseArgs({
      jsRuntime: 'node',
      proxy: 'socks5://tor:9050',
      extractorArgs: 'youtube:player_client=default',
    });
    expect(args.join(' ')).toContain('--proxy socks5://tor:9050');
    expect(args.join(' ')).toContain('--extractor-args youtube:player_client=default');
  });
});
