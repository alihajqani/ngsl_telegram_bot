import type { LazyRow, LeaderboardRow } from '@ngsl/db';
import { describe, expect, it } from 'vitest';
import { BOARD_SIZE, renderNightlyBoards, type BoardsView } from './boards-message.js';

const board = (count: number): LeaderboardRow[] =>
  Array.from({ length: count }, (_, i) => ({
    userId: i + 1,
    firstName: `User${i + 1}`,
    points: (count - i) * 10,
    rank: i + 1,
  }));

const lazy: LazyRow[] = [{ userId: 90, firstName: 'Sleepy', lastStudyDay: '2026-09-18', daysMissed: 6 }];

const view = (overrides: Partial<BoardsView> = {}): BoardsView => ({
  locale: 'fa',
  userId: 2,
  daysLeft: 3,
  league: { tier: 3, standings: board(8) },
  global: { top: board(12).slice(0, BOARD_SIZE), you: { rank: 2, points: 110 } },
  lazy,
  ...overrides,
});

describe('renderNightlyBoards', () => {
  it('shows the league, the all-time board and the lazy board in the learner language', () => {
    const text = renderNightlyBoards(view());
    expect(text).toContain('لیگ طلا');
    expect(text).toContain('برترین‌های همیشگی');
    expect(text).toContain('تابلوی تنبل‌ها');
    expect(text).toContain('Sleepy — 6 روز غیبت');
    expect(text).toContain('تنظیمات');
  });

  it('marks the recipient on both boards', () => {
    const lines = renderNightlyBoards(view()).split('\n');
    expect(lines.filter((l) => l.includes('User2') && l.endsWith('⬅️'))).toHaveLength(2);
  });

  it('caps each board and adds a rank line for a learner below the cut', () => {
    const text = renderNightlyBoards(
      view({
        userId: 25,
        league: { tier: 1, standings: board(30) },
        global: { top: board(BOARD_SIZE), you: { rank: 40, points: 5 } },
      }),
    );
    expect(text).not.toContain('User11 ');
    expect(text).toContain('<b>25</b>'); // league rank of user 25
    expect(text).toContain('<b>40</b>'); // all-time rank
  });

  it('invites a learner with no league this week to join one', () => {
    expect(renderNightlyBoards(view({ league: undefined }))).toContain('هنوز وارد لیگ این هفته نشده‌اید');
  });

  it('warns on Friday night that the league closes at midnight', () => {
    expect(renderNightlyBoards(view({ daysLeft: 1 }))).toContain('امشب نیمه‌شب');
    expect(renderNightlyBoards(view({ daysLeft: 3 }))).toContain('3 روز');
  });

  it('celebrates an empty lazy board', () => {
    expect(renderNightlyBoards(view({ lazy: [] }))).toContain('همه فعال‌اند');
  });

  it('escapes names, which users choose themselves', () => {
    const text = renderNightlyBoards(
      view({ lazy: [{ userId: 91, firstName: '<b>x</b>&', lastStudyDay: null, daysMissed: 4 }] }),
    );
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;&amp;');
  });

  it('renders English for English learners', () => {
    const text = renderNightlyBoards(view({ locale: 'en' }));
    expect(text).toContain('Gold league');
    expect(text).toContain('All-time leaders');
    expect(text).toContain('Lazy Board');
  });
});
