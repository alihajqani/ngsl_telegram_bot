import { getWordLemma, markClipsSeen, selectClipsForUser } from '@ngsl/db';
import { prewarmWords } from '@ngsl/queue';
import { createLogger } from '@ngsl/shared';
import type { InputMediaVideo } from 'grammy/types';
import { escapeHtml, t } from '../i18n/i18n.js';
import type { BotContext } from '../types.js';
import { awardQuietly } from './sessions.js';

const log = createLogger('bot.clips');

/** How many clips a single tap serves. */
const CLIPS_PER_REQUEST = 5;

/**
 * "Watch clips" — the payoff of the whole pipeline.
 *
 * Nothing here touches YouTube. Every clip is sent by its cached Telegram
 * `file_id`, so the response is a single API call with no download, no ffmpeg
 * and no exposure to bot detection. The clips are also guaranteed unseen: the
 * `user_clip_seen` anti-join means five fresh ones on learning and five
 * different ones on every review.
 */
export async function clipsHandler(ctx: BotContext): Promise<void> {
  const match = /^cl:(\d+)$/.exec(ctx.callbackQuery?.data ?? '');
  const userId = ctx.session.userId;

  if (!match || userId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  const wordId = Number(match[1]);

  await ctx.answerCallbackQuery();

  const { clips, exhausted } = await selectClipsForUser(userId, wordId, CLIPS_PER_REQUEST);

  if (clips.length === 0) {
    // Nothing rendered yet. Push this word to the front of the render queue so
    // the next attempt succeeds, and say so rather than showing an empty reply.
    void prewarmWords([wordId]).catch((error: unknown) =>
      log.warn('On-demand pre-warm failed', { userId, wordId, error }),
    );
    await ctx.reply(t('clips.preparing'), { parse_mode: 'HTML' });
    return;
  }

  const lemma = escapeHtml((await getWordLemma(wordId)) ?? '');
  await ctx.reply(t('clips.header', { lemma }), { parse_mode: 'HTML' });

  // A media group arrives as one grouped bubble instead of five separate
  // messages, and each item keeps its own sentence as the caption.
  const group: InputMediaVideo[] = clips.map((clip) => ({
    type: 'video',
    media: clip.telegramFileId,
    caption: t('clips.caption', { sentence: escapeHtml(clip.sentence) }),
    parse_mode: 'HTML',
  }));

  try {
    await ctx.replyWithMediaGroup(group);
  } catch (error) {
    // A stale file_id fails the whole group; fall back to sending individually
    // so one bad clip cannot cost the user the other four.
    log.warn('Media group failed; sending clips individually', { wordId, error });
    for (const clip of clips) {
      await ctx
        .replyWithVideo(clip.telegramFileId, {
          caption: t('clips.caption', { sentence: escapeHtml(clip.sentence) }),
          parse_mode: 'HTML',
        })
        .catch((sendError: unknown) => log.warn('Clip send failed', { wordId, sendError }));
    }
  }

  // Only mark as seen after a successful send, so a failure does not silently
  // burn clips the learner never actually watched.
  await markClipsSeen(userId, clips.map((c) => c.clipId));

  if (exhausted) {
    await ctx.reply(t('clips.exhausted'), { parse_mode: 'HTML' });
  }

  await awardQuietly(ctx, 'clip_watched', 1, wordId);
  log.info('Clips served', { userId, wordId, count: clips.length, exhausted });
}
