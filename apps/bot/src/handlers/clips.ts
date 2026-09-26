import {
  clipDeckForQuery,
  clipDeckForWord,
  findWordByLemma,
  getServableClip,
  getSettings,
  getWordLemma,
  markSegmentSeen,
  voteSegment,
  type ClipAccent,
} from '@ngsl/db';
import { reportFeature } from '@ngsl/monitor';
import { prewarmWords } from '@ngsl/queue';
import { createLogger } from '@ngsl/shared';
import { highlightForms, highlightMarked } from '../highlight.js';
import { escapeHtml, t } from '../i18n/i18n.js';
import { CB_PATTERN, clipKeyboard, isEnglishQuery } from '../keyboards.js';
import type { BotContext, ClipDeckState } from '../types.js';
import { awardQuietly } from './sessions.js';

const log = createLogger('bot.clips');

/** How many clips one deck holds; the arrows wrap around it. */
const DECK_SIZE = 30;

/**
 * Clips, YouGlish-style: one video at a time with arrows to page through the
 * rest, the word bolded in the caption, votes, and a link to the moment on
 * YouTube.
 *
 * Nothing here touches YouTube or ffmpeg. Every clip is a cached Telegram
 * `file_id`, so opening a deck is one message and every arrow tap swaps the
 * video in place with `editMessageMedia`. The deck's order is fixed when it
 * opens: never-seen clips first, one per video before any video's second.
 * The learner's accent setting (American by default) decides which channels
 * the deck draws on.
 */

/** Read when a deck is built: its order is fixed from then on. */
async function accentOf(userId: number): Promise<ClipAccent> {
  return (await getSettings(userId)).clipAccent;
}

/** "Watch clips" under a word card (`cl:<wordId>`). */
export async function clipsHandler(ctx: BotContext): Promise<void> {
  const match = /^cl:(\d+)$/.exec(ctx.callbackQuery?.data ?? '');
  await ctx.answerCallbackQuery();
  const userId = ctx.session.userId;
  if (!match || userId === undefined) return;
  const wordId = Number(match[1]);
  await openWordDeck(ctx, wordId, await accentOf(userId));
  if (ctx.from) reportFeature('clips', ctx.from, (await getWordLemma(wordId)) ?? `word ${wordId}`);
}

async function openWordDeck(ctx: BotContext, wordId: number, accent: ClipAccent): Promise<void> {
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  const deck = await clipDeckForWord(userId, wordId, DECK_SIZE, accent);
  if (deck.segmentIds.length === 0) {
    if (await hasOtherAccents(userId, accent, { wordId })) {
      await sayOtherAccent(ctx, (await getWordLemma(wordId)) ?? '', accent);
    } else {
      await askForRender(ctx, wordId);
    }
    return;
  }

  ctx.session.clipDeck = {
    key: `w${wordId}`,
    wordId,
    title: (await getWordLemma(wordId)) ?? '',
    segmentIds: deck.segmentIds,
  };
  await showClip(ctx, 0, 'send');
  // Someone is watching this word now: if its clips come from too few videos,
  // queue more. A no-op once the word reaches the breadth floor.
  void prewarmWords([wordId]).catch((error: unknown) =>
    log.warn('Deck pre-warm failed', { userId, wordId, error }),
  );
  await awardQuietly(ctx, 'clip_watched', 1, wordId);
}

/** Nothing rendered yet: put the word at the front of the render queue and say so. */
async function askForRender(ctx: BotContext, wordId: number): Promise<void> {
  void prewarmWords([wordId]).catch((error: unknown) =>
    log.warn('On-demand render request failed', { userId: ctx.session.userId, wordId, error }),
  );
  await ctx.reply(t('clips.preparing'), { parse_mode: 'HTML' });
}

/** Clips exist, just none in the learner's accent. */
async function hasOtherAccents(
  userId: number,
  accent: ClipAccent,
  target: { wordId?: number; query?: string },
): Promise<boolean> {
  if (accent === 'any') return false;
  const { wordId, query } = target;
  if (wordId !== undefined && (await clipDeckForWord(userId, wordId, 1, 'any')).segmentIds.length > 0) {
    return true;
  }
  return query !== undefined && (await clipDeckForQuery(userId, query, 1, 'any')).segmentIds.length > 0;
}

async function sayOtherAccent(ctx: BotContext, title: string, accent: ClipAccent): Promise<void> {
  await ctx.reply(
    t('clips.otherAccent', {
      title: escapeHtml(title),
      accent: t(`settings.accents.${accent}`),
      all: t('settings.accents.any'),
    }),
    { parse_mode: 'HTML' },
  );
}

/** The 🔎 menu button: the next message is the search. */
export async function searchPromptHandler(ctx: BotContext): Promise<void> {
  ctx.session.awaitingSearch = true;
  await ctx.reply(t('search.prompt'), { parse_mode: 'HTML' });
}

/**
 * Search any word or phrase. An exact NGSL lemma opens that word's deck, the
 * same one its card shows; anything else, or a word with no clips of its own
 * yet, is a phrase search over every rendered sentence.
 */
export async function searchHandler(ctx: BotContext, raw: string): Promise<void> {
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  const query = raw.trim().replace(/’/g, "'").replace(/\s+/g, ' ').toLowerCase();
  if (!isEnglishQuery(query)) {
    await ctx.reply(t('search.invalid'), { parse_mode: 'HTML' });
    return;
  }

  if (ctx.from) reportFeature('search', ctx.from, query);
  const accent = await accentOf(userId);
  const wordId = query.includes(' ') ? undefined : await findWordByLemma(query);
  if (wordId !== undefined) {
    const deck = await clipDeckForWord(userId, wordId, DECK_SIZE, accent);
    if (deck.segmentIds.length > 0) {
      await openWordDeck(ctx, wordId, accent);
      return;
    }
  }

  const deck = await clipDeckForQuery(userId, query, DECK_SIZE, accent);
  if (deck.segmentIds.length === 0) {
    if (await hasOtherAccents(userId, accent, { wordId, query })) {
      await sayOtherAccent(ctx, query, accent);
    } else if (wordId !== undefined) {
      await askForRender(ctx, wordId);
    } else {
      await ctx.reply(t('search.none', { query: escapeHtml(query) }), { parse_mode: 'HTML' });
    }
    return;
  }

  ctx.session.clipDeck = { key: 'q', query, title: query, segmentIds: deck.segmentIds };
  await showClip(ctx, 0, 'send');
  log.info('Clip search', { userId, results: deck.segmentIds.length });
}

/** ⏮ / ⏭ (`cv:<deck>:<position>`). */
export async function clipNavHandler(ctx: BotContext): Promise<void> {
  const match = CB_PATTERN.clipNav.exec(ctx.callbackQuery?.data ?? '');
  const userId = ctx.session.userId;
  if (!match || userId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  const [, key, position] = match;

  // The session holds one deck. Arrows on an older message rebuild a word's
  // deck on the spot; an old search cannot be rebuilt from the callback alone.
  if (ctx.session.clipDeck?.key !== key) {
    if (!key!.startsWith('w')) {
      await ctx.answerCallbackQuery({ text: t('clips.expired'), show_alert: true });
      return;
    }
    const wordId = Number(key!.slice(1));
    const deck = await clipDeckForWord(userId, wordId, DECK_SIZE, await accentOf(userId));
    if (deck.segmentIds.length === 0) {
      await ctx.answerCallbackQuery({ text: t('clips.unavailable') });
      return;
    }
    ctx.session.clipDeck = {
      key: key!,
      wordId,
      title: (await getWordLemma(wordId)) ?? '',
      segmentIds: deck.segmentIds,
    };
  }

  await ctx.answerCallbackQuery();
  await showClip(ctx, Number(position), 'edit');
}

/** 👍 / 👎 (`vt:<segmentId>:<l|d>`). */
export async function clipVoteHandler(ctx: BotContext): Promise<void> {
  const match = CB_PATTERN.clipVote.exec(ctx.callbackQuery?.data ?? '');
  const userId = ctx.session.userId;
  if (!match || userId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }

  const result = await voteSegment(userId, Number(match[1]), match[2] === 'l' ? 'like' : 'dislike');
  await ctx.answerCallbackQuery({ text: result.disabled ? t('clips.removed') : t('clips.voted') });
}

/** A stale `file_id` is dropped and the next clip tried, this many times at most. */
const MAX_SKIPS = 3;

/**
 * Show the clip at `position` of the session deck, by sending a new message or
 * by swapping the video inside the current one. Marks it seen only once
 * Telegram has accepted it, so a failed send never burns a clip.
 */
async function showClip(ctx: BotContext, position: number, mode: 'send' | 'edit'): Promise<void> {
  const deck = ctx.session.clipDeck;
  const userId = ctx.session.userId;
  if (!deck || userId === undefined) return;

  for (let attempt = 0; attempt <= MAX_SKIPS && deck.segmentIds.length > 0; attempt++) {
    const total = deck.segmentIds.length;
    const index = ((position % total) + total) % total;
    const segmentId = deck.segmentIds[index]!;

    const clip = await getServableClip(segmentId, { wordId: deck.wordId, query: deck.query });
    if (!clip) {
      deck.segmentIds.splice(index, 1);
      continue;
    }

    const caption = t('clips.caption', {
      header: headerFor(deck),
      sentence: clip.marked ? highlightMarked(clip.marked) : highlightForms(clip.sentence, clip.forms ?? []),
      channel: escapeHtml(clip.channelName),
      position: index + 1,
      total,
    });
    const keyboard = clipKeyboard(deck.key, index, total, clip);

    try {
      if (mode === 'send') {
        await ctx.replyWithVideo(clip.telegramFileId, {
          caption,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } else {
        await ctx.editMessageMedia(
          { type: 'video', media: clip.telegramFileId, caption, parse_mode: 'HTML' },
          { reply_markup: keyboard },
        );
      }
    } catch (error) {
      log.warn('Clip send failed; skipping it', { userId, segmentId, error });
      deck.segmentIds.splice(index, 1);
      continue;
    }

    await markSegmentSeen(userId, segmentId);
    return;
  }

  await ctx.reply(t('clips.unavailable'), { parse_mode: 'HTML' });
}

function headerFor(deck: ClipDeckState): string {
  return deck.wordId !== undefined
    ? t('clips.header', { lemma: escapeHtml(deck.title) })
    : t('clips.searchHeader', { query: escapeHtml(deck.title) });
}
