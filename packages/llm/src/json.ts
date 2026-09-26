import { createLogger } from '@ngsl/shared';
import type { z } from 'zod';
import {
  complete,
  LlmIncompleteError,
  type ChatMessage,
  type CompletionOptions,
} from './provider.js';

const log = createLogger('llm.json');

export class LlmSchemaError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'LlmSchemaError';
  }
}

/**
 * Strip the wrapping models add even when asked not to.
 *
 * JSON mode makes this rare, but vLLM-served open models still emit ```json
 * fences or a sentence of preamble often enough that giving up on the whole
 * batch would be wasteful.
 *
 * The payload is the first complete value, not everything up to the last
 * brace: gemma-4 sometimes finishes the JSON and then writes on, and parsing
 * the two together failed batches whose answer was complete.
 */
export function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();

  const firstBrace = candidate.search(/[[{]/);
  if (firstBrace === -1) return candidate;
  const end = endOfValue(candidate, firstBrace);
  if (end !== undefined) return candidate.slice(firstBrace, end);

  // Never closed: the answer was cut off. Parsing still fails, with its own error.
  const lastBrace = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  return lastBrace > firstBrace ? candidate.slice(firstBrace, lastBrace + 1) : candidate;
}

/** Index just past the bracket that closes the one at `start`, skipping string contents. */
function endOfValue(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

/**
 * Complete and validate against a schema, retrying once on malformed output.
 *
 * The retry is worth it: a single bad generation in a 2,809-word batch should
 * cost one extra call, not a failed run. An answer that came back empty or cut
 * off is a bad generation too; any other provider error is not retried here.
 */
export async function completeJson<T>(
  messages: ChatMessage[],
  // Input is `unknown`, not `T`: the value being parsed is whatever the model
  // returned. Pinning input to the output type would reject any schema that
  // coerces a field — which is exactly what an untrusted payload needs.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: CompletionOptions = {},
  attempts = 2,
): Promise<T> {
  let lastError: unknown;
  let lastRaw = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let raw: string;
    try {
      raw = await complete(messages, { ...options, json: true });
    } catch (error) {
      if (!(error instanceof LlmIncompleteError)) throw error;
      lastError = error;
      log.debug('LLM returned an incomplete answer', { attempt });
      continue;
    }
    lastRaw = raw;
    try {
      return schema.parse(JSON.parse(extractJson(raw)));
    } catch (error) {
      lastError = error;
      log.debug('LLM produced unusable JSON', { attempt });
    }
  }

  // Its message names the finish reason, which a schema error would hide.
  if (lastError instanceof LlmIncompleteError) throw lastError;
  throw new LlmSchemaError(
    `LLM output failed validation after ${attempts} attempts: ${String(lastError)}`,
    lastRaw,
  );
}
