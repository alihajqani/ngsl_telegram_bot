import { and, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';
import { db, type Database } from '../client.js';
import { appUser, pointsLedger, userSettings, userStreak, userWord, video } from '../schema.js';

/** User settings, admin statistics, and the reminder audience query. */

type Row<T> = T & Record<string, unknown>;

export interface Settings {
  dailyNewTarget: number;
  dailyReviewTarget: number;
  preferredDictionary: 'cambridge' | 'oxford';
  remindersEnabled: boolean;
  motivationEnabled: boolean;
  digestEnabled: boolean;
  wallOfShameOptin: boolean;
  timezone: string;
}

const DEFAULTS: Settings = {
  dailyNewTarget: 5,
  dailyReviewTarget: 10,
  preferredDictionary: 'cambridge',
  remindersEnabled: true,
  motivationEnabled: false,
  digestEnabled: true,
  wallOfShameOptin: false,
  timezone: 'Asia/Tehran',
};

export async function getSettings(
  userId: number,
  database: Database = db(),
): Promise<Settings> {
  const [row] = await database
    .select({
      dailyNewTarget: userSettings.dailyNewTarget,
      dailyReviewTarget: userSettings.dailyReviewTarget,
      preferredDictionary: userSettings.preferredDictionary,
      remindersEnabled: userSettings.remindersEnabled,
      motivationEnabled: userSettings.motivationEnabled,
      digestEnabled: userSettings.digestEnabled,
      wallOfShameOptin: userSettings.wallOfShameOptin,
      timezone: userSettings.timezone,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  return row ?? DEFAULTS;
}

export async function updateSettings(
  userId: number,
  patch: Partial<Settings>,
  database: Database = db(),
): Promise<void> {
  await database
    .insert(userSettings)
    .values({ userId, ...DEFAULTS, ...patch })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { ...patch, updatedAt: new Date() },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin
// ─────────────────────────────────────────────────────────────────────────────

export interface AdminStats {
  users: number;
  activeToday: number;
  activeWeek: number;
  blocked: number;
  wordsLearned: number;
  pointsAwarded: number;
  liveVideos: number;
  deadVideos: number;
  renderedClips: number;
}

export async function adminStats(database: Database = db()): Promise<AdminStats> {
  const [row] = await database.execute<Row<AdminStats>>(sql`
    select
      (select count(*)::int from ${appUser})                                        as "users",
      (select count(*)::int from ${appUser}
        where last_active_at >= now() - interval '1 day')                           as "activeToday",
      (select count(*)::int from ${appUser}
        where last_active_at >= now() - interval '7 days')                          as "activeWeek",
      (select count(*)::int from ${appUser} where blocked)                          as "blocked",
      (select count(*)::int from ${userWord})                                       as "wordsLearned",
      (select coalesce(sum(delta), 0)::int from ${pointsLedger})                     as "pointsAwarded",
      (select count(*)::int from ${video} where status = 'live')                    as "liveVideos",
      (select count(*)::int from ${video} where status = 'dead')                    as "deadVideos",
      (select count(*)::int from clip where telegram_file_id is not null)           as "renderedClips"
  `);
  return row!;
}

/** Broadcast audience: everyone who has not blocked the bot. */
export async function broadcastAudience(
  database: Database = db(),
): Promise<{ telegramId: number; locale: 'fa' | 'en' }[]> {
  return database
    .select({ telegramId: appUser.telegramId, locale: appUser.locale })
    .from(appUser)
    .where(eq(appUser.blocked, false));
}

/**
 * Flag a user who has blocked the bot, so every later bulk send skips them.
 * Cleared automatically by `upsertUser` on their next interaction.
 */
export async function flagBlocked(
  telegramId: number,
  database: Database = db(),
): Promise<void> {
  await database
    .update(appUser)
    .set({ blocked: true, blockedAt: new Date() })
    .where(eq(appUser.telegramId, telegramId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Reminders
// ─────────────────────────────────────────────────────────────────────────────

export interface ReminderTarget {
  userId: number;
  telegramId: number;
  locale: 'fa' | 'en';
  firstName: string | null;
  currentStreak: number;
  lastStudyDay: string | null;
}

/**
 * Who should be nudged in this UTC hour.
 *
 * The audience is defined by each learner's own peak activity hour, taken from
 * the 24-slot histogram. Below `minInteractions` the histogram is noise, so
 * those users fall back to a sensible default hour rather than being reminded
 * at whatever minute they happened to first open the bot.
 */
export async function remindersDueThisHour(
  utcHour: number,
  options: { minInteractions?: number; defaultHour?: number } = {},
  database: Database = db(),
): Promise<ReminderTarget[]> {
  const { minInteractions = 5, defaultHour = 17 } = options;

  const rows = await database.execute<Row<ReminderTarget>>(sql`
    with histogram as (
      select user_id,
             sum(count)::int as total,
             (array_agg(hour order by count desc, hour))[1] as peak
        from activity_hour
       group by user_id
    )
    select u.id            as "userId",
           u.telegram_id   as "telegramId",
           u.locale,
           u.first_name    as "firstName",
           coalesce(s.current, 0)::int as "currentStreak",
           s.last_study_day as "lastStudyDay"
      from ${appUser} u
      join ${userSettings} st on st.user_id = u.id
      left join histogram h on h.user_id = u.id
      left join ${userStreak} s on s.user_id = u.id
     where not u.blocked
       and st.reminders_enabled
       -- Only learners with something to come back to.
       and exists (select 1 from ${userWord} w where w.user_id = u.id)
       -- Not already studied today, in their own timezone.
       and (s.last_study_day is null
            or s.last_study_day < (now() at time zone st.timezone)::date)
       -- Their personal peak hour, or the default when the histogram is thin.
       and ${utcHour} = case
             when coalesce(h.total, 0) >= ${minInteractions} then h.peak
             else ${defaultHour}
           end
  `);
  return [...rows];
}

/** Audience for the daily motivational line and the morning digest. */
export async function dailyDispatchAudience(
  kind: 'motivation' | 'digest',
  database: Database = db(),
): Promise<ReminderTarget[]> {
  const flag =
    kind === 'motivation' ? userSettings.motivationEnabled : userSettings.digestEnabled;

  const rows = await database
    .select({
      userId: appUser.id,
      telegramId: appUser.telegramId,
      locale: appUser.locale,
      firstName: appUser.firstName,
      currentStreak: sql<number>`coalesce(${userStreak.current}, 0)::int`,
      lastStudyDay: userStreak.lastStudyDay,
    })
    .from(appUser)
    .innerJoin(userSettings, eq(userSettings.userId, appUser.id))
    .leftJoin(userStreak, eq(userStreak.userId, appUser.id))
    .where(and(eq(appUser.blocked, false), eq(flag, true)));

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Video health
// ─────────────────────────────────────────────────────────────────────────────

/** Least-recently-probed live videos — the weekly health sweep's worklist. */
export async function videosToProbe(
  limit: number,
  staleAfterDays: number,
  database: Database = db(),
): Promise<{ id: number; ytVideoId: string }[]> {
  return database
    .select({ id: video.id, ytVideoId: video.ytVideoId })
    .from(video)
    .where(
      and(
        eq(video.status, 'live'),
        isNotNull(video.indexedAt),
        sql`(${video.healthCheckedAt} is null or ${video.healthCheckedAt} < now() - make_interval(days => ${staleAfterDays}))`,
      ),
    )
    .orderBy(sql`${video.healthCheckedAt} nulls first`)
    .limit(limit);
}

export async function markVideoHealthy(
  videoId: number,
  database: Database = db(),
): Promise<void> {
  await database
    .update(video)
    .set({ healthCheckedAt: new Date() })
    .where(eq(video.id, videoId));
}

/**
 * Retire a dead source.
 *
 * Only `video.status` changes. Clips keep their `telegram_file_id` and still
 * play from Telegram's CDN forever — the serving query filters on the video's
 * status, so a removed YouTube upload stops producing NEW clips without
 * invalidating anything already minted.
 */
export async function markVideoDeadById(
  videoId: number,
  database: Database = db(),
): Promise<void> {
  await database
    .update(video)
    .set({ status: 'dead', healthCheckedAt: new Date() })
    .where(eq(video.id, videoId));
}

export async function countUsersWithWords(database: Database = db()): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(distinct ${userWord.userId})::int` })
    .from(userWord)
    .where(gt(userWord.reviewCount, -1));
  return row?.count ?? 0;
}

export { lte };
