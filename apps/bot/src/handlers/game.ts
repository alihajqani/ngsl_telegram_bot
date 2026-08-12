import {
  createBuddyPair,
  findBuddy,
  findUserByTelegramId,
  getStreak,
  globalLeaderboard,
  globalRank,
  lazyBoard,
  leagueStandings,
  currentMembership,
  setWallOfShameOptin,
  totalPoints,
} from '@ngsl/db';
import {
  dayKey,
  LAZY_THRESHOLD_DAYS,
  streakStatus,
  tierName,
  weekStartKey,
} from '@ngsl/core';
import { config, createLogger } from '@ngsl/shared';
import { InlineKeyboard } from 'grammy';
import { escapeHtml, t } from '../i18n/i18n.js';
import type { BotContext } from '../types.js';

const log = createLogger('bot.game');

const MEDALS = ['🥇', '🥈', '🥉'];
const medal = (rank: number): string => MEDALS[rank - 1] ?? `${rank}.`;

const today = (): string => dayKey(new Date(), config().app.timezone);

/** Streak, multiplier, freezes and points — the "where do I stand" screen. */
export async function streakHandler(ctx: BotContext): Promise<void> {
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  const [streak, points, buddy] = await Promise.all([
    getStreak(userId),
    totalPoints(userId),
    findBuddy(userId),
  ]);

  const status = streakStatus(streak, today());
  const flame = status === 'active' ? '🔥' : status === 'atRisk' ? '🧊' : '💤';

  const lines = [
    t('game.streakHeader'),
    '',
    t('game.streakLine', { flame, current: streak.current, longest: streak.longest }),
    t('game.multiplierLine', { multiplier: streak.multiplier.toFixed(1) }),
    t('game.freezeLine', { freezes: streak.freezesAvailable }),
    t('game.pointsLine', { points }),
  ];

  if (status === 'atRisk') lines.push('', t('game.atRisk'));

  if (buddy) {
    lines.push('', t('game.buddyLine', { streak: buddy.jointStreak }));
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text(t('game.leagueButton'), 'league')
      .text(t('game.globalButton'), 'global')
      .row()
      .text(t('game.buddyButton'), 'buddy'),
  });
}

/** This week's cohort — the board that actually drives behaviour. */
export async function leagueHandler(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  const membership = await currentMembership(userId, weekStartKey(today()));
  if (!membership) {
    await ctx.reply(t('game.noLeague'), { parse_mode: 'HTML' });
    return;
  }

  const standings = await leagueStandings(membership.leagueId);
  const lines = [
    t('game.leagueHeader', { tier: t(`game.tiers.${tierName(membership.tier)}`) }),
    '',
  ];

  for (const row of standings.slice(0, 30)) {
    const you = row.userId === userId ? ' ⬅️' : '';
    const zone =
      row.rank <= 5 ? '🔼' : row.rank > standings.length - 5 && standings.length > 10 ? '🔽' : '  ';
    lines.push(
      `${zone} ${medal(row.rank)} ${escapeHtml(row.firstName ?? '—')} — <b>${row.points}</b>${you}`,
    );
  }

  lines.push('', t('game.leagueFooter'));
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

/** All-time board — vanity, deliberately secondary to the league. */
export async function globalBoardHandler(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  const [top, mine] = await Promise.all([globalLeaderboard(15), globalRank(userId)]);
  const lines = [t('game.globalHeader'), ''];

  for (const row of top) {
    const you = row.userId === userId ? ' ⬅️' : '';
    lines.push(`${medal(row.rank)} ${escapeHtml(row.firstName ?? '—')} — <b>${row.points}</b>${you}`);
  }

  if (mine && !top.some((r) => r.userId === userId)) {
    lines.push('', t('game.yourRank', { rank: mine.rank, points: mine.points }));
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

/**
 * Buddy invite.
 *
 * The link is a Telegram deep link carrying the inviter's id, so accepting is
 * one tap and the invitee lands in the bot already paired. That is the viral
 * loop: using the feature requires bringing someone in.
 */
export async function buddyHandler(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  const existing = await findBuddy(userId);
  if (existing) {
    await ctx.reply(t('game.buddyActive', { streak: existing.jointStreak }), {
      parse_mode: 'HTML',
    });
    return;
  }

  const me = await ctx.api.getMe();
  const link = `https://t.me/${me.username}?start=buddy_${userId}`;

  await ctx.reply(t('game.buddyInvite', { link }), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

/**
 * Accept a buddy invitation from a `/start buddy_<id>` deep link.
 * Returns true when a pair was formed, so `/start` can adjust its greeting.
 */
export async function tryAcceptBuddy(ctx: BotContext, payload: string): Promise<boolean> {
  const match = /^buddy_(\d+)$/.exec(payload);
  const userId = ctx.session.userId;
  if (!match || userId === undefined) return false;

  const inviterId = Number(match[1]);
  if (inviterId === userId) {
    await ctx.reply(t('game.buddySelf'), { parse_mode: 'HTML' });
    return false;
  }

  if ((await findBuddy(userId)) || (await findBuddy(inviterId))) {
    await ctx.reply(t('game.buddyTaken'), { parse_mode: 'HTML' });
    return false;
  }

  const pairId = await createBuddyPair(inviterId, userId);
  if (pairId === undefined) return false;

  await ctx.reply(t('game.buddyPaired'), { parse_mode: 'HTML' });
  log.info('Buddy pair formed', { inviterId, userId });
  return true;
}

/** The opt-in Lazy Board, with its redemption path stated on the board itself. */
export async function lazyBoardHandler(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const rows = await lazyBoard(today(), LAZY_THRESHOLD_DAYS, 15);

  const lines = [t('game.lazyHeader'), ''];
  if (rows.length === 0) {
    lines.push(t('game.lazyEmpty'));
  } else {
    for (const row of rows) {
      lines.push(`😴 ${escapeHtml(row.firstName ?? '—')} — ${t('game.lazyDays', { days: row.daysMissed })}`);
    }
    lines.push('', t('game.lazyRedemption'));
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard()
      .text(t('game.lazyOptIn'), 'shame:on')
      .text(t('game.lazyOptOut'), 'shame:off'),
  });
}

export async function wallOptInHandler(ctx: BotContext): Promise<void> {
  const optIn = ctx.callbackQuery?.data === 'shame:on';
  await ctx.answerCallbackQuery({ text: optIn ? t('game.lazyJoined') : t('game.lazyLeft') });

  const userId = ctx.session.userId;
  if (userId === undefined) return;
  await setWallOfShameOptin(userId, optIn);
}

export { findUserByTelegramId };
