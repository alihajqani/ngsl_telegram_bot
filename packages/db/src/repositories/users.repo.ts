import { eq, sql } from 'drizzle-orm';
import { db, type Database } from '../client.js';
import { appUser, userSettings } from '../schema.js';

export interface AppUserRecord {
  id: number;
  telegramId: number;
  locale: 'fa' | 'en';
  firstName: string | null;
}

export interface UpsertedUser extends AppUserRecord {
  /** This call inserted the row: the user is new. */
  created: boolean;
}

/**
 * Register or refresh a Telegram user.
 *
 * The settings row is created alongside so every later read can assume it
 * exists — `getDailyLimits` still defends with defaults, but this keeps the
 * common path a plain join instead of a null check.
 *
 * `locale` is only set on insert: a returning user who switched the bot to
 * English must not have that overwritten by their Telegram client language.
 *
 * `created` comes from the same statement: a row the insert wrote has `xmax`
 * 0, a row the conflict branch updated does not. A second query could not
 * tell a new user from one who tapped twice at once.
 */
export async function upsertUser(
  telegramId: number,
  profile: { firstName?: string; username?: string; languageCode?: 'fa' | 'en' },
  database: Database = db(),
): Promise<UpsertedUser> {
  const [row] = await database
    .insert(appUser)
    .values({
      telegramId,
      firstName: profile.firstName ?? null,
      username: profile.username ?? null,
      locale: profile.languageCode ?? 'fa',
      lastActiveAt: new Date(),
    })
    .onConflictDoUpdate({
      target: appUser.telegramId,
      set: {
        firstName: sql`excluded.first_name`,
        username: sql`excluded.username`,
        lastActiveAt: sql`excluded.last_active_at`,
        // Any interaction proves they have not blocked the bot.
        blocked: false,
        blockedAt: null,
      },
    })
    .returning({
      id: appUser.id,
      telegramId: appUser.telegramId,
      locale: appUser.locale,
      firstName: appUser.firstName,
      created: sql<boolean>`(xmax = 0)`,
    });

  await database.insert(userSettings).values({ userId: row!.id }).onConflictDoNothing();
  return row!;
}

export async function countUsers(database: Database = db()): Promise<number> {
  const [row] = await database.select({ count: sql<number>`count(*)::int` }).from(appUser);
  return row?.count ?? 0;
}

export async function findUserByTelegramId(
  telegramId: number,
  database: Database = db(),
): Promise<AppUserRecord | undefined> {
  const [row] = await database
    .select({
      id: appUser.id,
      telegramId: appUser.telegramId,
      locale: appUser.locale,
      firstName: appUser.firstName,
    })
    .from(appUser)
    .where(eq(appUser.telegramId, telegramId));
  return row;
}

export async function setLocale(
  userId: number,
  locale: 'fa' | 'en',
  database: Database = db(),
): Promise<void> {
  await database.update(appUser).set({ locale }).where(eq(appUser.id, userId));
}

/**
 * Record an update from the user: a count in the 24-slot histogram that drives
 * peak-hour reminders, and the end of a `blocked` flag.
 *
 * The flag is cleared here, on every update, because `upsertUser` runs only
 * when the session has no user id. A learner a bulk send flagged, and who then
 * wrote to the bot with their session intact, stayed blocked for good: no
 * reminders, and gone from the league tables. After a bot token switch that is
 * every learner the new bot messaged before they had started it.
 */
export async function touchActivity(
  userId: number,
  hour: number,
  database: Database = db(),
): Promise<void> {
  await database.execute(sql`
    with unblocked as (
      update app_user set blocked = false, blocked_at = null
      where id = ${userId} and blocked
    )
    insert into activity_hour (user_id, hour, count)
    values (${userId}, ${hour}, 1)
    on conflict (user_id, hour) do update set count = activity_hour.count + 1
  `);
}
