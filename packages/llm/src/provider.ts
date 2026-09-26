import { config, createLogger, proxyDispatcher, resetProxyDispatcher } from '@ngsl/shared';
import { fetch as undiciFetch } from 'undici';

const log = createLogger('llm.provider');

/**
 * LLM dispatch: Gemini first, vLLM as the fallback when every key is rate limited.
 *
 * Both providers are driven over plain HTTP rather than an SDK. v1 pulled in
 * `@google/genai` and then had to swap `globalThis.fetch` for a proxy-aware one
 * to make it work behind a proxy — monkey-patching a global because the SDK
 * owned the transport. Talking to the REST endpoints directly keeps proxying,
 * timeouts, key rotation and retries all in one place.
 */

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface CompletionOptions {
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask the provider to emit strict JSON. Both backends support this natively. */
  json?: boolean;
}

export class AllKeysExhaustedError extends Error {
  constructor(readonly provider: string) {
    super(`Every ${provider} API key is rate limited`);
    this.name = 'AllKeysExhaustedError';
  }
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/**
 * The provider answered, but the answer is empty or was cut off at the token
 * limit. Unlike the other errors this belongs to one generation, so asking
 * again can succeed.
 */
export class LlmIncompleteError extends LlmUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'LlmIncompleteError';
  }
}

/** Round-robin cursor, so load spreads across keys instead of burning the first. */
let keyCursor = 0;

function isRateLimited(status: number): boolean {
  return status === 429 || status === 503;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return undiciFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config().llm.timeoutMs),
    dispatcher: proxyDispatcher(),
  });
}

interface GeminiPayload {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; thought?: boolean }[] };
  }[];
  usageMetadata?: { thoughtsTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * The answer text of a Gemini response.
 *
 * Thinking models (Gemma 4, Gemini 2.5) also return their reasoning, as parts
 * flagged `thought: true`. Joined into the answer, that reasoning — which
 * drafts the JSON with `"..."` placeholders — was parsed instead of the real
 * payload, and every generated word was silently dropped.
 */
export function geminiAnswerText(payload: GeminiPayload): string {
  return (
    payload.candidates?.[0]?.content?.parts
      ?.filter((part) => part.thought !== true)
      .map((part) => part.text ?? '')
      .join('') ?? ''
  );
}

/**
 * Why a Gemini answer is unusable, or undefined when it is fine: empty, or cut
 * off at the output limit. The finish reason and token counts go into the
 * message, so a failure says whether the reasoning used up the budget.
 */
export function geminiIncomplete(payload: GeminiPayload, text: string): string | undefined {
  const finishReason = payload.candidates?.[0]?.finishReason ?? 'none';
  const empty = text.trim() === '';
  if (!empty && finishReason !== 'MAX_TOKENS') return undefined;

  const usage = payload.usageMetadata;
  return (
    `${empty ? 'no answer' : 'answer cut off'} (finishReason ${finishReason}, ` +
    `thoughtsTokenCount ${usage?.thoughtsTokenCount ?? 0}, ` +
    `candidatesTokenCount ${usage?.candidatesTokenCount ?? 0})`
  );
}

/**
 * Output budget. A thinking model spends part of it reasoning before it writes
 * the answer, so a batch of eight words' JSON needs far more than the answer's
 * own ~1,500 tokens.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** Waits before each retry of a server error: Gemini's 500s are usually momentary. */
const SERVER_RETRY_DELAYS_MS = [2_000, 6_000];

/**
 * Retry a request that failed on the server's side (5xx), a few times with a
 * growing pause. Client errors and 429s are returned at once: a 429 is handled
 * by rotating keys, and a 4xx will not change by asking again. In one full
 * content run, nine of ten failed batches were a single Gemini 500.
 */
export async function withServerRetry<R extends { status: number }>(
  request: () => Promise<R>,
  delaysMs: readonly number[] = SERVER_RETRY_DELAYS_MS,
): Promise<R> {
  let response = await request();
  for (const delay of delaysMs) {
    if (response.status < 500) break;
    log.debug('LLM server error, retrying', { status: response.status, delay });
    await new Promise((resolve) => setTimeout(resolve, delay));
    response = await request();
  }
  return response;
}

async function callGemini(messages: ChatMessage[], options: CompletionOptions): Promise<string> {
  const { apiKeys, model } = config().llm.gemini;
  if (apiKeys.length === 0) throw new AllKeysExhaustedError('gemini');

  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');

  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      temperature: options.temperature ?? 0.4,
      maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      // Native JSON mode removes an entire class of "model wrapped it in prose"
      // parse failures that v1 handled by stripping code fences after the fact.
      ...(options.json ? { responseMimeType: 'application/json' } : {}),
    },
  };

  // Try every key once before giving up: a 429 on one key says nothing about the next.
  for (let attempt = 0; attempt < apiKeys.length; attempt++) {
    const key = apiKeys[(keyCursor + attempt) % apiKeys.length]!;
    const response = await withServerRetry(() =>
      post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        body,
        { 'x-goog-api-key': key },
      ),
    );

    if (isRateLimited(response.status)) {
      log.debug('Gemini key rate limited, rotating', { attempt });
      continue;
    }
    if (!response.ok) {
      throw new LlmUnavailableError(`Gemini responded ${response.status}: ${await response.text()}`);
    }

    keyCursor = (keyCursor + attempt + 1) % apiKeys.length;
    const payload = (await response.json()) as GeminiPayload;
    const text = geminiAnswerText(payload);
    const problem = geminiIncomplete(payload, text);
    if (problem) throw new LlmIncompleteError(`Gemini returned ${problem}`);
    return text;
  }

  throw new AllKeysExhaustedError('gemini');
}

async function callVllm(messages: ChatMessage[], options: CompletionOptions): Promise<string> {
  const vllm = config().llm.vllm;
  if (!vllm) throw new LlmUnavailableError('vLLM is not configured');

  const response = await post(
    `${vllm.baseUrl.replace(/\/$/, '')}/v1/chat/completions`,
    {
      model: vllm.model,
      messages,
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxOutputTokens ?? 2048,
      ...(options.json ? { response_format: { type: 'json_object' } } : {}),
    },
    vllm.apiKey ? { authorization: `Bearer ${vllm.apiKey}` } : {},
  );

  if (!response.ok) {
    throw new LlmUnavailableError(`vLLM responded ${response.status}: ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string } }[];
  };
  const choice = payload.choices?.[0];
  const text = choice?.message?.content ?? '';
  if (text.trim() === '' || choice?.finish_reason === 'length') {
    const what = text.trim() === '' ? 'no answer' : 'answer cut off';
    const reason = choice?.finish_reason ?? 'none';
    throw new LlmIncompleteError(`vLLM returned ${what} (finish_reason ${reason})`);
  }
  return text;
}

/**
 * Run a completion against the configured provider.
 *
 * Gemini exhausting its keys is the one failure worth falling back on — it is
 * transient and self-inflicted by rate limits, whereas a 400 means the request
 * itself is wrong and retrying elsewhere would just fail again.
 */
export async function complete(
  messages: ChatMessage[],
  options: CompletionOptions = {},
): Promise<string> {
  const { provider, vllm } = config().llm;

  if (provider === 'gemini') {
    try {
      return await callGemini(messages, options);
    } catch (error) {
      if (error instanceof AllKeysExhaustedError && vllm) {
        log.warn('Gemini exhausted; falling back to vLLM');
        return callVllm(messages, options);
      }
      throw error;
    }
  }
  return callVllm(messages, options);
}

/** Test seam — drops the memoized proxy dispatcher. */
export function resetProvider(): void {
  resetProxyDispatcher();
  keyCursor = 0;
}
