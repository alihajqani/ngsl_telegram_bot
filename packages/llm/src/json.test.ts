import { describe, expect, it } from 'vitest';
import { extractJson } from './json.js';

describe('extractJson', () => {
  it('passes through clean JSON untouched', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('unwraps a ```json fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('unwraps a bare fence', () => {
    expect(extractJson('```\n[1,2]\n```')).toBe('[1,2]');
  });

  it('discards prose surrounding the payload', () => {
    // Open models served by vLLM add this often enough to matter across 2,809 words.
    expect(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
  });

  it('handles arrays as the top-level value', () => {
    expect(extractJson('Here:\n[{"x":1}]')).toBe('[{"x":1}]');
  });

  it('leaves text with no JSON alone rather than mangling it', () => {
    expect(extractJson('I cannot help with that')).toBe('I cannot help with that');
  });

  it('keeps nested braces intact', () => {
    const nested = '{"a":{"b":[1,2]},"c":"}"}';
    expect(extractJson(nested)).toBe(nested);
  });
});
