import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

/** Which end of a channel's upload history to crawl first. */
export const crawlOrderSchema = z.enum(['newest', 'oldest']);
export type CrawlOrder = z.infer<typeof crawlOrderSchema>;

const channelSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, 'slug must be kebab-case'),
  name: z.string().min(1),
  url: z.string().refine((u) => /^https:\/\/(www\.)?youtube\.com\//.test(u), 'must be a youtube.com URL'),
  tier: z.number().int().min(1).max(3).default(1),
  accent: z.string().min(1).optional(),
  /**
   * Defaults to oldest-first. YouTube retired community-contributed captions in
   * September 2020, so older uploads carry human-authored subtitles far more
   * often — for some channels it is the difference between 0% and 100% yield.
   */
  order: crawlOrderSchema.default('oldest'),
  enabled: z.boolean().default(true),
});

export type ChannelConfig = z.infer<typeof channelSchema>;

const fileSchema = z.object({
  channels: z.array(channelSchema).min(1),
});

export class ChannelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelConfigError';
  }
}

/** Pure — takes YAML text, not a path, so it is testable without the filesystem. */
export function parseChannelsYaml(contents: string): ChannelConfig[] {
  let raw: unknown;
  try {
    raw = parse(contents);
  } catch (error) {
    throw new ChannelConfigError(
      `channels.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = fileSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ChannelConfigError(`channels.yml is invalid — ${detail}`);
  }

  const slugs = new Set<string>();
  for (const channel of result.data.channels) {
    if (slugs.has(channel.slug)) {
      throw new ChannelConfigError(`channels.yml has a duplicate slug: ${channel.slug}`);
    }
    slugs.add(channel.slug);
  }

  return result.data.channels;
}

export async function loadChannels(path: string): Promise<ChannelConfig[]> {
  return parseChannelsYaml(await readFile(path, 'utf8'));
}

export const enabledChannels = (channels: readonly ChannelConfig[]): ChannelConfig[] =>
  channels.filter((c) => c.enabled);
