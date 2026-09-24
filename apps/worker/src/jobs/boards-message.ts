import { PROMOTE_COUNT, DEMOTE_COUNT, tierName, type Tier } from '@ngsl/core';
import type { LazyRow, LeaderboardRow } from '@ngsl/db';
import { InlineKeyboard } from 'grammy';

/**
 * The nightly boards message: this week's league, the all-time board and the
 * Lazy Board, in one message so the evening costs the learner one notification.
 *
 * Copy is duplicated from the bot's catalogue for the same reason as the
 * reminders: the worker has no request-scoped locale to resolve `t()` against.
 */

/** Rows shown per board; the learner's own rank is added when they fall below. */
export const BOARD_SIZE = 10;

/** Handled by the bot: must match `CB.digestOff` in `apps/bot/src/keyboards.ts`. */
const DIGEST_OFF_CALLBACK = 'dg:off';

const COPY = {
  fa: {
    header: '🌙 <b>جدول‌های امشب</b>',
    league: (tier: string) => `🏆 <b>لیگ ${tier}</b>`,
    daysLeft: (days: number) =>
      days === 1
        ? '⏳ لیگ این هفته امشب نیمه‌شب بسته می‌شود!'
        : `⏳ ${days} روز تا پایان لیگ این هفته`,
    zones: '<i>🔼 پنج نفر اول صعود، 🔽 پنج نفر آخر سقوط می‌کنند.</i>',
    noLeague: 'هنوز وارد لیگ این هفته نشده‌اید. با یک درس یا مرور وارد لیگ می‌شوید.',
    global: '🌍 <b>برترین‌های همیشگی</b>',
    yourRank: (rank: number, points: number) => `رتبهٔ شما: <b>${rank}</b> با ${points} امتیاز`,
    lazy: '😴 <b>تابلوی تنبل‌ها</b>',
    lazyEmpty: 'هیچ‌کس اینجا نیست، همه فعال‌اند! 🎉',
    lazyDays: (days: number) => `${days} روز غیبت`,
    lazyRedemption: '<i>یک جلسهٔ مطالعه کافی است تا از این تابلو خارج شوید.</i>',
    offButton: '🔕 خاموش کردن جدول‌های شبانه',
    tiers: { bronze: 'برنز', silver: 'نقره', gold: 'طلا', sapphire: 'یاقوت', diamond: 'الماس' },
  },
  en: {
    header: "🌙 <b>Tonight's boards</b>",
    league: (tier: string) => `🏆 <b>${tier} league</b>`,
    daysLeft: (days: number) =>
      days === 1
        ? "⏳ This week's league closes at midnight tonight!"
        : `⏳ ${days} days left in this week's league`,
    zones: '<i>🔼 Top five promote, 🔽 bottom five relegate.</i>',
    noLeague: 'You are not in a league this week yet. A lesson or a review puts you in one.',
    global: '🌍 <b>All-time leaders</b>',
    yourRank: (rank: number, points: number) => `Your rank: <b>${rank}</b> with ${points} points`,
    lazy: '😴 <b>Lazy Board</b>',
    lazyEmpty: 'Nobody here, everyone is active! 🎉',
    lazyDays: (days: number) => `${days} days away`,
    lazyRedemption: '<i>One study session takes you off this board.</i>',
    offButton: '🔕 Turn off nightly boards',
    tiers: { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', sapphire: 'Sapphire', diamond: 'Diamond' },
  },
} as const satisfies Record<'fa' | 'en', { tiers: Record<Tier, string> } & Record<string, unknown>>;

const MEDALS = ['🥇', '🥈', '🥉'];
const medal = (rank: number): string => MEDALS[rank - 1] ?? `${rank}.`;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface BoardsView {
  locale: 'fa' | 'en';
  /** The recipient, marked on every board they appear on. */
  userId: number;
  /** Days left in the league week, today included. */
  daysLeft: number;
  /** The recipient's league this week; absent until their first activity. */
  league?: { tier: number; standings: readonly LeaderboardRow[] };
  global: { top: readonly LeaderboardRow[]; you?: { rank: number; points: number } };
  lazy: readonly LazyRow[];
}

function boardLine(row: LeaderboardRow, userId: number, zone = ''): string {
  const you = row.userId === userId ? ' ⬅️' : '';
  return `${zone}${medal(row.rank)} ${escapeHtml(row.firstName ?? '—')} — <b>${row.points}</b>${you}`;
}

export function renderNightlyBoards(view: BoardsView): string {
  const copy = COPY[view.locale];
  const lines: string[] = [copy.header, ''];

  if (view.league) {
    const { standings } = view.league;
    lines.push(copy.league(copy.tiers[tierName(view.league.tier)]), copy.daysLeft(view.daysLeft), '');
    // Same zones as the in-bot league screen.
    for (const row of standings.slice(0, BOARD_SIZE)) {
      const zone =
        row.rank <= PROMOTE_COUNT
          ? '🔼 '
          : row.rank > standings.length - DEMOTE_COUNT && standings.length > 10
            ? '🔽 '
            : '';
      lines.push(boardLine(row, view.userId, zone));
    }
    const mine = standings.find((row) => row.userId === view.userId);
    if (mine && mine.rank > BOARD_SIZE) lines.push('', copy.yourRank(mine.rank, mine.points));
    lines.push(copy.zones);
  } else {
    lines.push(copy.noLeague);
  }

  lines.push('', copy.global);
  for (const row of view.global.top) lines.push(boardLine(row, view.userId));
  const you = view.global.you;
  if (you && !view.global.top.some((row) => row.userId === view.userId)) {
    lines.push(copy.yourRank(you.rank, you.points));
  }

  lines.push('', copy.lazy);
  if (view.lazy.length === 0) {
    lines.push(copy.lazyEmpty);
  } else {
    for (const row of view.lazy) {
      const you = row.userId === view.userId ? ' ⬅️' : '';
      lines.push(`😴 ${escapeHtml(row.firstName ?? '—')} — ${copy.lazyDays(row.daysMissed)}${you}`);
    }
    lines.push(copy.lazyRedemption);
  }

  return lines.join('\n');
}

/** One tap under the message switches it off; settings can turn it back on. */
export function nightlyBoardsKeyboard(locale: 'fa' | 'en'): InlineKeyboard {
  return new InlineKeyboard().text(COPY[locale].offButton, DIGEST_OFF_CALLBACK);
}
