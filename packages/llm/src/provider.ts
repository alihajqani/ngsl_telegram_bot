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
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
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
 * Output budget. A thinking model spends part of it reasoning before it writes
 * the answer, so a batch of eight words' JSON needs far more than the answer's
 * own ~1,500 tokens.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

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
    const response = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      body,
      { 'x-goog-api-key': key },
    );

    if (isRateLimited(response.status)) {
      log.debug('Gemini key rate limited, rotating', { attempt });
      continue;
    }
    if (!response.ok) {
      throw new LlmUnavailableError(`Gemini responded ${response.status}: ${await response.text()}`);
    }

    keyCursor = (keyCursor + attempt + 1) % apiKeys.length;
    const text = geminiAnswerText((await response.json()) as GeminiPayload);
    if (text.trim() === '') throw new LlmUnavailableError('Gemini returned an empty completion');
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

  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = payload.choices?.[0]?.message?.content ?? '';
  if (text.trim() === '') throw new LlmUnavailableError('vLLM returned an empty completion');
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
