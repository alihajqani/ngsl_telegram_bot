import { describe, expect, it } from 'vitest';
import { dayKey, isSameLocalDay, previousDayKey, remainingToday } from './time.js';

const TEHRAN = 'Asia/Tehran';

describe('dayKey', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(dayKey(new Date('2026-08-10T09:00:00Z'), TEHRAN)).toBe('2026-08-10');
  });

  it('uses the local calendar, not UTC', () => {
    // 21:30 UTC is already the next day in Tehran (+03:30).
    expect(dayKey(new Date('2026-08-10T21:30:00Z'), TEHRAN)).toBe('2026-08-11');
    expect(dayKey(new Date('2026-08-10T21:30:00Z'), 'UTC')).toBe('2026-08-10');
  });

  it('handles the half-hour offset around local midnight', () => {
    expect(dayKey(new Date('2026-08-10T20:29:00Z'), TEHRAN)).toBe('2026-08-10');
    expect(dayKey(new Date('2026-08-10T20:31:00Z'), TEHRAN)).toBe('2026-08-11');
  });
});

describe('isSameLocalDay', () => {
  it('groups two instants inside one local day', () => {
    const a = new Date('2026-08-10T21:00:00Z'); // 2026-08-11 in Tehran
    const b = new Date('2026-08-11T05:00:00Z'); // 2026-08-11 in Tehran
    expect(isSameLocalDay(a, b, TEHRAN)).toBe(true);
    expect(isSameLocalDay(a, b, 'UTC')).toBe(false);
  });
});

describe('previousDayKey', () => {
  it('returns yesterday in local terms', () => {
    expect(previousDayKey(new Date('2026-08-10T09:00:00Z'), TEHRAN)).toBe('2026-08-09');
  });

  it('crosses a month boundary', () => {
    expect(previousDayKey(new Date('2026-09-01T09:00:00Z'), TEHRAN)).toBe('2026-08-31');
  });
});

describe('remainingToday', () => {
  it('subtracts what has been done', () => {
    expect(remainingToday(10, 4)).toBe(6);
  });

  it('is zero once the goal is met', () => {
    expect(remainingToday(10, 10)).toBe(0);
  });

  it('never goes negative when the target is lowered mid-day', () => {
    expect(remainingToday(5, 12)).toBe(0);
  });
});
