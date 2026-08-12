import { createLogger } from '@ngsl/shared';
import type { z } from 'zod';
import { complete, type ChatMessage, type CompletionOptions } from './provider.js';

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
 */
export function extractJson(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();

  // Fall back to the outermost bracketed span if prose surrounds the payload.
  const firstBrace = candidate.search(/[[{]/);
  if (firstBrace === -1) return candidate;
  const lastBrace = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
  return lastBrace > firstBrace ? candidate.slice(firstBrace, lastBrace + 1) : candidate;
}

/**
 * Complete and validate against a schema, retrying once on malformed output.
 *
 * The retry is worth it: a single bad generation in a 2,809-word batch should
 * cost one extra call, not a failed run.
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
    const raw = await complete(messages, { ...options, json: true });
    lastRaw = raw;
    try {
      return schema.parse(JSON.parse(extractJson(raw)));
    } catch (error) {
      lastError = error;
      log.debug('LLM produced unusable JSON', { attempt });
    }
  }

  throw new LlmSchemaError(
    `LLM output failed validation after ${attempts} attempts: ${String(lastError)}`,
    lastRaw,
  );
}
