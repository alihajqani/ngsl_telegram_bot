import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { generateCollocations, generateExamples, generateWordDetails } = vi.hoisted(() => ({
  generateCollocations: vi.fn(),
  generateExamples: vi.fn(),
  generateWordDetails: vi.fn(),
}));

vi.mock('@ngsl/content', () => ({ generateCollocations, generateExamples, generateWordDetails }));
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
    generateWordDetails.mockReset().mockResolvedValue(stats);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills collocations, then grammar details, then examples, under one deadline', async () => {
    const order: string[] = [];
    generateCollocations.mockImplementation(() => (order.push('collocations'), Promise.resolve(stats)));
    generateWordDetails.mockImplementation(() => (order.push('details'), Promise.resolve(stats)));
    generateExamples.mockImplementation(() => (order.push('examples'), Promise.resolve(stats)));

    await runContentFill(60_000);

    expect(order).toEqual(['collocations', 'details', 'examples']);
    expect(generateCollocations).toHaveBeenCalledWith({ deadline: START + 60_000 });
    expect(generateWordDetails).toHaveBeenCalledWith({ deadline: START + 60_000 });
    expect(generateExamples).toHaveBeenCalledWith({ deadline: START + 60_000 });
  });

  it('leaves the later passes to the next run when collocations used the whole budget', async () => {
    generateCollocations.mockImplementation(() => {
      vi.setSystemTime(START + 61_000);
      return Promise.resolve(stats);
    });

    await runContentFill(60_000);

    expect(generateWordDetails).not.toHaveBeenCalled();
    expect(generateExamples).not.toHaveBeenCalled();
  });

  it('leaves examples to the next run when details used the rest of the budget', async () => {
    generateWordDetails.mockImplementation(() => {
      vi.setSystemTime(START + 61_000);
      return Promise.resolve(stats);
    });

    await runContentFill(60_000);

    expect(generateWordDetails).toHaveBeenCalled();
    expect(generateExamples).not.toHaveBeenCalled();
  });
});
