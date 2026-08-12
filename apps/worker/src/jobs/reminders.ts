import { dailyDispatchAudience, remindersDueThisHour, type ReminderTarget } from '@ngsl/db';
import { dayKey, streakStatus } from '@ngsl/core';
import { config, createLogger } from '@ngsl/shared';
import { Bot, GrammyError } from 'grammy';
import { flagBlocked } from '@ngsl/db';

const log = createLogger('worker.reminders');

/** Same pacing rationale as the broadcast: stay well under ~30 msg/s. */
const SEND_INTERVAL_MS = 45;

let bot: Bot | undefined;
function api(): Bot {
  bot ??= new Bot(config().telegram.botToken);
  return bot;
}

/**
 * Copy is duplicated here rather than imported from the bot's i18n catalogue.
 *
 * The worker is a separate process with no request context, and pulling the
 * bot's AsyncLocalStorage-based `t()` across the boundary would mean carrying a
 * locale scope through every queue job. These few strings are the cheaper trade.
 */
const COPY = {
  fa: {
    nudge: '📚 وقت مطالعه است! چند واژهٔ تازه منتظر شماست.',
    atRisk: (days: number) => `🧊 رشتهٔ ${days} روزهٔ شما امروز در خطر است! یک مرور کوتاه کافی است.`,
    motivation: '🌅 صبح بخیر! امروز هم چند دقیقه برای انگلیسی وقت بگذارید.',
  },
  en: {
    nudge: '📚 Time to study! A few fresh words are waiting for you.',
    atRisk: (days: number) => `🧊 Your ${days}-day streak is at risk today! A short review is enough.`,
    motivation: '🌅 Good morning! Give English a few minutes today.',
  },
} as const;

async function deliver(target: ReminderTarget, text: string): Promise<boolean> {
  try {
    await api().api.sendMessage(target.telegramId, text, { parse_mode: 'HTML' });
    return true;
  } catch (error) {
    if (error instanceof GrammyError && (error.error_code === 403 || error.error_code === 400)) {
      await flagBlocked(target.telegramId).catch(() => undefined);
    } else {
      log.warn('Reminder send failed', { userId: target.userId, error });
    }
    return false;
  }
}

export interface DispatchResult {
  audience: number;
  sent: number;
}

/**
 * Hourly nudge at each learner's own peak activity hour.
 *
 * Runs every hour; the query selects only the users whose personal peak matches
 * the current UTC hour and who have not studied today, so a learner receives at
 * most one nudge a day at the time they are actually most likely to act.
 */
export async function runPeakHourReminders(now: Date = new Date()): Promise<DispatchResult> {
  const targets = await remindersDueThisHour(now.getUTCHours());
  const today = dayKey(now, config().app.timezone);
  let sent = 0;

  for (const target of targets) {
    const copy = COPY[target.locale];
    const status = streakStatus(
      {
        current: target.currentStreak,
        longest: target.currentStreak,
        lastStudyDay: target.lastStudyDay,
        freezesAvailable: 0,
        multiplier: 1,
      },
      today,
    );

    // A streak at risk is a far stronger motivator than a generic nudge.
    const text =
      status === 'atRisk' && target.currentStreak > 0
        ? copy.atRisk(target.currentStreak)
        : copy.nudge;

    if (await deliver(target, text)) sent += 1;
    await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
  }

  log.info('Peak-hour reminders dispatched', { hour: now.getUTCHours(), audience: targets.length, sent });
  return { audience: targets.length, sent };
}

/** Opt-in morning motivation. */
export async function runDailyMotivation(): Promise<DispatchResult> {
  const targets = await dailyDispatchAudience('motivation');
  let sent = 0;

  for (const target of targets) {
    if (await deliver(target, COPY[target.locale].motivation)) sent += 1;
    await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
  }

  log.info('Daily motivation dispatched', { audience: targets.length, sent });
  return { audience: targets.length, sent };
}
