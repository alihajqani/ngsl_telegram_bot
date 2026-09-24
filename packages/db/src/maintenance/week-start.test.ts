import { describe, expect, it } from 'vitest';
import { isMondayKey, saturdayWeekFor } from './week-start.js';

// 2026-09-21 is a Monday; 2026-09-19 the Saturday before it.

describe('saturdayWeekFor', () => {
  it('moves the running week onto the Saturday week that contains today', () => {
    expect(saturdayWeekFor('2026-09-21', '2026-09-24')).toBe('2026-09-19'); // Thursday
    expect(saturdayWeekFor('2026-09-21', '2026-09-25')).toBe('2026-09-19'); // Friday
  });

  it('keeps a weekend switch-over inside the running week', () => {
    // On Saturday and Sunday the Monday week is still running but the Saturday
    // week has already turned over, so the league joins the new week.
    expect(saturdayWeekFor('2026-09-21', '2026-09-26')).toBe('2026-09-26');
    expect(saturdayWeekFor('2026-09-21', '2026-09-27')).toBe('2026-09-26');
  });

  it('moves a finished week to the Saturday before its Monday', () => {
    expect(saturdayWeekFor('2026-09-14', '2026-09-24')).toBe('2026-09-12');
    expect(saturdayWeekFor('2026-01-05', '2026-09-24')).toBe('2026-01-03');
  });
});

describe('isMondayKey', () => {
  it('recognises only Mondays', () => {
    expect(isMondayKey('2026-09-21')).toBe(true);
    expect(isMondayKey('2026-09-19')).toBe(false);
    expect(isMondayKey('2026-09-24')).toBe(false);
  });
});
