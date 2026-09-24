import { dailyDispatchAudience, remindersDueThisHour } from '@ngsl/db';
import { dayKey, streakStatus } from '@ngsl/core';
import { config, createLogger } from '@ngsl/shared';
import { deliver, pace, type DispatchResult } from './dispatch.js';

const log = createLogger('worker.reminders');

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
    await pace();
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
    await pace();
  }

  log.info('Daily motivation dispatched', { audience: targets.length, sent });
  return { audience: targets.length, sent };
}
