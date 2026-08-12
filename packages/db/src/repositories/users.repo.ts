import { eq, sql } from 'drizzle-orm';
import { db, type Database } from '../client.js';
import { appUser, userSettings } from '../schema.js';

export interface AppUserRecord {
  id: number;
  telegramId: number;
  locale: 'fa' | 'en';
  firstName: string | null;
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
 */
export async function upsertUser(
  telegramId: number,
  profile: { firstName?: string; username?: string; languageCode?: 'fa' | 'en' },
  database: Database = db(),
): Promise<AppUserRecord> {
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
    });

  await database.insert(userSettings).values({ userId: row!.id }).onConflictDoNothing();
  return row!;
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

export async function touchActivity(
  userId: number,
  hour: number,
  database: Database = db(),
): Promise<void> {
  // Upsert into the 24-slot histogram that drives peak-hour reminders.
  await database.execute(sql`
    insert into activity_hour (user_id, hour, count)
    values (${userId}, ${hour}, 1)
    on conflict (user_id, hour) do update set count = activity_hour.count + 1
  `);
}
