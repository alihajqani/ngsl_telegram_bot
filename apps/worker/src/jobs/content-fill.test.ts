import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { generateCollocations, generateExamples } = vi.hoisted(() => ({
  generateCollocations: vi.fn(),
  generateExamples: vi.fn(),
}));

vi.mock('@ngsl/content', () => ({ generateCollocations, generateExamples }));
vi.mock('@ngsl/shared', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { runContentFill } = await import('./content-fill.js');

const START = new Date('2026-09-26T08:00:00.000Z').getTime();
const stats = { wordsConsidered: 8, wordsWritten: 8, itemsWritten: 40, batchesFailed: 0 };

describe('runContentFill', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    generateCollocations.mockReset().mockResolvedValue(stats);
    generateExamples.mockReset().mockResolvedValue(stats);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills collocations first, then examples, under one deadline', async () => {
    const order: string[] = [];
    generateCollocations.mockImplementation(() => (order.push('collocations'), Promise.resolve(stats)));
    generateExamples.mockImplementation(() => (order.push('examples'), Promise.resolve(stats)));

    await runContentFill(60_000);

    expect(order).toEqual(['collocations', 'examples']);
    expect(generateCollocations).toHaveBeenCalledWith({ deadline: START + 60_000 });
    expect(generateExamples).toHaveBeenCalledWith({ deadline: START + 60_000 });
  });

  it('leaves examples to the next run when collocations used the whole budget', async () => {
    generateCollocations.mockImplementation(() => {
      vi.setSystemTime(START + 61_000);
      return Promise.resolve(stats);
    });

    await runContentFill(60_000);

    expect(generateExamples).not.toHaveBeenCalled();
  });
});
