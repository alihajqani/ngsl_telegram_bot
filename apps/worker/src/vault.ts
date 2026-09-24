import { config, createLogger } from '@ngsl/shared';
import type { CutResult } from '@ngsl/media';
import { Bot, GrammyError, InputFile } from 'grammy';

const log = createLogger('worker.vault');

/**
 * The clip vault.
 *
 * A private forum topic whose only purpose is to hold uploaded clips so Telegram
 * mints a `file_id` for each one. That id can then be sent to any user, by this
 * bot, instantly and for free — no download, no ffmpeg, no exposure to YouTube's
 * bot wall on the request path.
 *
 * This is the single strongest idea carried over from v1, and it is why the
 * expensive work can happen entirely offline.
 */

let bot: Bot | undefined;

function vaultBot(): Bot {
  bot ??= new Bot(config().telegram.botToken);
  return bot;
}

export class VaultNotConfiguredError extends Error {
  constructor() {
    super(
      'CLIP_VAULT_GROUP_ID and CLIP_VAULT_THREAD_ID must be set to render clips. ' +
        'Create a forum-enabled group, add the bot as admin, and read the topic id from getUpdates.',
    );
    this.name = 'VaultNotConfiguredError';
  }
}

export function isVaultConfigured(): boolean {
  return config().media.vault !== undefined;
}

/**
 * Telegram lets a bot post about 20 messages a minute into one group, and the
 * vault is one group, often the same one the monitor posts its topics into.
 * Uploads take 15 of those 20 slots, leaving room for the monitor, instead of
 * running into 429s mid-video.
 */
const UPLOAD_INTERVAL_MS = 4_000;
const MAX_ATTEMPTS = 4;
let lastUploadAt = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Upload a cut clip and return its reusable `file_id`.
 *
 * Dimensions, duration, a thumbnail and `supports_streaming` go with it, so
 * Telegram shows the right frame at once and starts playback before the file
 * has finished downloading. The caption is provenance, not decoration: it
 * makes the vault browsable when a clip needs auditing.
 */
export async function uploadToVault(
  clip: CutResult,
  meta: { ytVideoId: string; startMs: number; endMs: number; sentence?: string },
): Promise<string> {
  const vault = config().media.vault;
  if (!vault) throw new VaultNotConfiguredError();

  const seconds = ((meta.endMs - meta.startMs) / 1000).toFixed(1);
  const caption = [
    `<code>${meta.ytVideoId}</code> ${(meta.startMs / 1000).toFixed(2)}s +${seconds}s`,
    meta.sentence ? escapeHtml(meta.sentence.slice(0, 300)) : undefined,
  ]
    .filter(Boolean)
    .join('\n');

  for (let attempt = 1; ; attempt++) {
    const wait = lastUploadAt + UPLOAD_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastUploadAt = Date.now();

    try {
      const message = await vaultBot().api.sendVideo(vault.groupId, new InputFile(clip.path), {
        message_thread_id: vault.threadId,
        caption,
        parse_mode: 'HTML',
        disable_notification: true,
        supports_streaming: true,
        width: clip.width,
        height: clip.height,
        duration: Math.max(1, Math.round(clip.durationMs / 1000)),
        thumbnail: new InputFile(clip.thumbnailPath),
      });

      const fileId = message.video?.file_id;
      if (!fileId) throw new Error(`Vault upload returned no video for ${meta.ytVideoId}`);
      log.debug('Minted file_id', { videoId: meta.ytVideoId });
      return fileId;
    } catch (error) {
      const retryAfter =
        error instanceof GrammyError && error.error_code === 429
          ? (error.parameters.retry_after ?? 30)
          : undefined;
      if (retryAfter === undefined || attempt >= MAX_ATTEMPTS) throw error;
      log.warn('Vault upload rate-limited; waiting', { videoId: meta.ytVideoId, retryAfter });
      await sleep((retryAfter + 1) * 1000);
    }
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
