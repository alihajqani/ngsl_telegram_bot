import { config, createLogger } from '@ngsl/shared';
import { Bot, InputFile } from 'grammy';

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
 * Upload a rendered clip and return its reusable `file_id`.
 *
 * The caption is provenance, not decoration: it makes the vault browsable when
 * a clip needs to be audited or manually pulled.
 */
export async function uploadToVault(
  filePath: string,
  meta: { ytVideoId: string; startMs: number; endMs: number; sentence?: string },
): Promise<string> {
  const vault = config().media.vault;
  if (!vault) throw new VaultNotConfiguredError();

  const seconds = Math.round((meta.endMs - meta.startMs) / 1000);
  const caption = [
    `<code>${meta.ytVideoId}</code> ${(meta.startMs / 1000).toFixed(1)}s +${seconds}s`,
    meta.sentence ? escapeHtml(meta.sentence.slice(0, 300)) : undefined,
  ]
    .filter(Boolean)
    .join('\n');

  const message = await vaultBot().api.sendVideo(vault.groupId, new InputFile(filePath), {
    message_thread_id: vault.threadId,
    caption,
    parse_mode: 'HTML',
    disable_notification: true,
  });

  const fileId = message.video.file_id;
  if (!fileId) {
    throw new Error(`Vault upload returned no file_id for ${meta.ytVideoId}`);
  }

  log.debug('Minted file_id', { videoId: meta.ytVideoId });
  return fileId;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
