import {
  ProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit,
  type Response,
} from 'undici';
import { config } from './config.js';

/**
 * One proxy agent for the whole process.
 *
 * Every outbound HTTPS call that can be blocked upstream (Telegram, Gemini)
 * goes through this, so a restricted network is a single env var rather than a
 * per-call concern. Resolved lazily and cached: building a ProxyAgent per
 * request would leak sockets.
 */

let dispatcher: Dispatcher | undefined;
let resolved = false;

export function proxyDispatcher(): Dispatcher | undefined {
  if (!resolved) {
    const proxy = config().app.httpsProxy;
    dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
    resolved = true;
  }
  return dispatcher;
}

/** `fetch`, routed through the configured proxy. */
export function proxyFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: proxyDispatcher() });
}

/** Test-only: drop the memoized agent (pairs with `resetConfig`). */
export function resetProxyDispatcher(): void {
  dispatcher = undefined;
  resolved = false;
}
