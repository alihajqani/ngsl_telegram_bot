import {
  cancelSession,
  findOpenSession,
  getWritingSummary,
} from '@ngsl/db';
import {
  checkLength,
  NotEnoughWordsError,
  primeSample,
  startWritingSession,
  submitWriting,
  MAX_WORDS,
  MIN_WORDS,
  type WritingFeedback,
} from '@ngsl/coach';
import { reportFeature } from '@ngsl/monitor';
import { createLogger } from '@ngsl/shared';
import { InlineKeyboard } from 'grammy';
import { escapeHtml, t } from '../i18n/i18n.js';
import type { BotContext } from '../types.js';
import { awardQuietly } from './sessions.js';

const log = createLogger('bot.writing');

/**
 * `/write`.
 *
 * Creates the session, shows the prompt, and kicks off the independent sample
 * in the background — so by the time the learner has written a paragraph, the
 * comparison text is usually already sitting in the database.
 */
export async function writeHandler(ctx: BotContext): Promise<void> {
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  let started;
  try {
    started = await startWritingSession(userId);
  } catch (error) {
    if (error instanceof NotEnoughWordsError) {
      await ctx.reply(t('writing.notEnoughWords'), { parse_mode: 'HTML' });
      return;
    }
    throw error;
  }

  ctx.session.writingSessionId = started.sessionId;

  // Replay the rolling memory before they start: the point of tracking recurring
  // mistakes is that the learner sees them while writing, not only after.
  const summary = started.summary;
  if (summary && summary.grammarPatterns.length > 0) {
    const lines = [t('writing.memoryHeader')];
    for (const pattern of summary.grammarPatterns) lines.push(`• ${escapeHtml(pattern)}`);
    if (summary.lastSessionNote) {
      lines.push('', `<i>${escapeHtml(summary.lastSessionNote)}</i>`);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  }

  await ctx.reply(
    t('writing.prompt', {
      words: started.lemmas.map((l) => `<b>${escapeHtml(l)}</b>`).join('، '),
      min: MIN_WORDS,
      max: MAX_WORDS,
    }),
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text(t('writing.cancelButton'), 'wcancel'),
    },
  );

  // Fire-and-forget: never make the learner wait on an LLM to start writing.
  void primeSample(started.sessionId, started.lemmas);
}

/** True when this text message should be treated as a writing submission. */
export async function hasOpenWritingSession(ctx: BotContext): Promise<boolean> {
  const userId = ctx.session.userId;
  if (userId === undefined) return false;
  if (ctx.session.writingSessionId !== undefined) return true;
  // Survive a cleared session by checking the database.
  return (await findOpenSession(userId)) !== undefined;
}

export async function writingSubmissionHandler(ctx: BotContext): Promise<void> {
  const userId = ctx.session.userId;
  const text = ctx.message?.text;
  if (userId === undefined || !text) return;

  const { verdict, words } = checkLength(text);
  if (verdict !== 'ok') {
    await ctx.reply(
      t(verdict === 'too-short' ? 'writing.tooShort' : 'writing.tooLong', {
        words,
        min: MIN_WORDS,
        max: MAX_WORDS,
      }),
      { parse_mode: 'HTML' },
    );
    return;
  }

  const thinking = await ctx.reply(t('writing.grading'), { parse_mode: 'HTML' });

  let result;
  try {
    result = await submitWriting(userId, text);
  } catch (error) {
    log.warn('Writing feedback failed', { userId, error });
    await ctx.api
      .deleteMessage(thinking.chat.id, thinking.message_id)
      .catch(() => undefined);
    await ctx.reply(t('writing.llmUnavailable'), { parse_mode: 'HTML' });
    return;
  }

  await ctx.api.deleteMessage(thinking.chat.id, thinking.message_id).catch(() => undefined);
  ctx.session.writingSessionId = undefined;

  if (!result) {
    await ctx.reply(t('errors.session'), { parse_mode: 'HTML' });
    return;
  }

  // Order is deliberate: their own work and its correction first, the native
  // version only afterwards, so the comparison lands on reflection.
  await ctx.reply(formatFeedback(result.feedback), { parse_mode: 'HTML' });
  await ctx.reply(
    `${t('writing.correctedHeader')}\n\n${escapeHtml(result.feedback.correctedText)}`,
    { parse_mode: 'HTML' },
  );

  if (result.sample) {
    await ctx.reply(
      `${t('writing.sampleHeader')}\n\n${escapeHtml(result.sample)}\n\n` +
        `<i>${t('writing.sampleNote')}</i>`,
      { parse_mode: 'HTML' },
    );
  }

  await awardQuietly(ctx, 'writing_submitted');
  log.info('Writing session graded', { userId, score: result.feedback.score });
  if (ctx.from) {
    reportFeature('writing', ctx.from, `${words} words · score ${result.feedback.score}`);
  }
}

export async function cancelWritingHandler(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const userId = ctx.session.userId;
  if (userId === undefined) return;

  const open = await findOpenSession(userId);
  if (open) await cancelSession(open.id);
  ctx.session.writingSessionId = undefined;

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  await ctx.reply(t('writing.cancelled'), { parse_mode: 'HTML' });
}

function formatFeedback(feedback: WritingFeedback): string {
  const stars = '⭐'.repeat(Math.max(1, Math.round(feedback.score / 2)));
  const lines = [
    t('writing.feedbackHeader', { score: feedback.score, stars }),
    '',
    escapeHtml(feedback.overallComment),
  ];

  if (feedback.vocabularyUsed.length > 0) {
    lines.push('', t('writing.used', { words: feedback.vocabularyUsed.map(escapeHtml).join('، ') }));
  }
  if (feedback.vocabularyMissing.length > 0) {
    lines.push(
      t('writing.missed', { words: feedback.vocabularyMissing.map(escapeHtml).join('، ') }),
    );
  }
  if (feedback.grammarIssues.length > 0) {
    lines.push('', t('writing.issuesHeader'));
    for (const issue of feedback.grammarIssues) lines.push(`• ${escapeHtml(issue)}`);
  }
  if (feedback.suggestions.length > 0) {
    lines.push('', t('writing.suggestionsHeader'));
    for (const suggestion of feedback.suggestions) lines.push(`• ${escapeHtml(suggestion)}`);
  }

  return lines.join('\n');
}

/** Re-exported so the router can check state without importing the repo. */
export { getWritingSummary };
