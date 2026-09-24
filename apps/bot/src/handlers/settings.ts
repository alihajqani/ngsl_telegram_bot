import { getSettings, setLocale, updateSettings, type Settings } from '@ngsl/db';
import { InlineKeyboard } from 'grammy';
import { runWithLocale, t, type LocaleCode } from '../i18n/i18n.js';
import { mainMenuKeyboard } from '../keyboards.js';
import type { BotContext } from '../types.js';

/**
 * Settings panel.
 *
 * Rendered once and edited in place, so changing four options leaves one
 * message in the chat rather than four. Callback data stays terse to fit
 * Telegram's 64-byte limit: `st:<field>:<value>`.
 */

const NEW_STEPS = [3, 5, 10, 15, 20];
const REVIEW_STEPS = [5, 10, 20, 30, 50];

function panelText(settings: Settings): string {
  return [
    t('settings.header'),
    '',
    t('settings.newTarget', { value: settings.dailyNewTarget }),
    t('settings.reviewTarget', { value: settings.dailyReviewTarget }),
    '',
    t('settings.hint'),
  ].join('\n');
}

function panelKeyboard(settings: Settings, locale: LocaleCode): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard.text(t('settings.newLabel'), 'st:noop').row();
  for (const value of NEW_STEPS) {
    keyboard.text(
      value === settings.dailyNewTarget ? `• ${value} •` : String(value),
      `st:nw:${value}`,
    );
  }

  keyboard.row().text(t('settings.reviewLabel'), 'st:noop').row();
  for (const value of REVIEW_STEPS) {
    keyboard.text(
      value === settings.dailyReviewTarget ? `• ${value} •` : String(value),
      `st:rv:${value}`,
    );
  }

  keyboard
    .row()
    .text(
      t('settings.dictionary', { value: t(`settings.dict.${settings.preferredDictionary}`) }),
      'st:dc',
    )
    .row()
    .text(t(settings.remindersEnabled ? 'settings.remindersOn' : 'settings.remindersOff'), 'st:re')
    .text(
      t(settings.motivationEnabled ? 'settings.motivationOn' : 'settings.motivationOff'),
      'st:mo',
    )
    .row()
    .text(t(settings.digestEnabled ? 'settings.digestOn' : 'settings.digestOff'), 'st:dg')
    .row()
    .text(t(settings.wallOfShameOptin ? 'settings.shameOn' : 'settings.shameOff'), 'st:ws')
    .row()
    .text(t('settings.language', { value: locale === 'fa' ? 'فارسی' : 'English' }), 'st:lg');

  return keyboard;
}

export async function settingsHandler(ctx: BotContext): Promise<void> {
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  const settings = await getSettings(userId);
  await ctx.reply(panelText(settings), {
    parse_mode: 'HTML',
    reply_markup: panelKeyboard(settings, ctx.session.locale ?? 'fa'),
  });
}

export async function settingsCallbackHandler(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';
  const userId = ctx.session.userId;
  if (userId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === 'st:noop') {
    await ctx.answerCallbackQuery();
    return;
  }

  const current = await getSettings(userId);
  const patch: Partial<Settings> = {};
  let localeChanged: LocaleCode | undefined;

  const numeric = /^st:(nw|rv):(\d+)$/.exec(data);
  if (numeric) {
    const value = Number(numeric[2]);
    if (numeric[1] === 'nw') patch.dailyNewTarget = value;
    else patch.dailyReviewTarget = value;
  } else {
    switch (data) {
      case 'st:dc':
        patch.preferredDictionary =
          current.preferredDictionary === 'cambridge' ? 'oxford' : 'cambridge';
        break;
      case 'st:re':
        patch.remindersEnabled = !current.remindersEnabled;
        break;
      case 'st:mo':
        patch.motivationEnabled = !current.motivationEnabled;
        break;
      case 'st:dg':
        patch.digestEnabled = !current.digestEnabled;
        break;
      case 'st:ws':
        patch.wallOfShameOptin = !current.wallOfShameOptin;
        break;
      case 'st:lg':
        localeChanged = (ctx.session.locale ?? 'fa') === 'fa' ? 'en' : 'fa';
        break;
      default:
        await ctx.answerCallbackQuery();
        return;
    }
  }

  if (localeChanged) {
    await setLocale(userId, localeChanged);
    ctx.session.locale = localeChanged;
  } else {
    await updateSettings(userId, patch);
  }

  await ctx.answerCallbackQuery({ text: t('settings.saved') });

  const updated = { ...current, ...patch };
  const locale = localeChanged ?? ctx.session.locale ?? 'fa';

  // Re-render inside the (possibly new) locale so the panel and the reply
  // keyboard switch language together.
  await runWithLocale(locale, async () => {
    await ctx
      .editMessageText(panelText(updated), {
        parse_mode: 'HTML',
        reply_markup: panelKeyboard(updated, locale),
      })
      .catch(() => undefined);

    if (localeChanged) {
      await ctx.reply(t('settings.languageChanged'), {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(),
      });
    }
  });
}
