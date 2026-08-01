import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { channelTarget } from '../schemas/brief.js';
import { getConfigRoot } from './paths.js';

/**
 * User-level config at `<configRoot>/config.json` — shared across every
 * initiative, unlike `brief.md`'s per-initiative `channels` field. Only
 * `channels` is modeled here today; `discovery` (written by `setup`'s config
 * stub) isn't read from disk anywhere yet, so it's deliberately left out of
 * this schema rather than validated and then ignored.
 */
export const GlobalConfigSchema = z.object({
  channels: z.array(channelTarget).optional(),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

/**
 * Channels loaded on every `aw`/`open` launch when the user's config.json
 * doesn't say otherwise. agent-chat is here so a fresh install still gets a
 * working bus without hand-editing config.json first — see the "Agent
 * Coordination" policy in the global CLAUDE.md.
 */
export const FALLBACK_DEFAULT_CHANNELS: string[] = ['plugin:agent-chat@agent-chat-local'];

/**
 * Read and validate `<configRoot>/config.json`. Fails open: a missing file,
 * unparsable JSON, or a `channels` entry that doesn't validate all fall back
 * to `{}` rather than throwing — a malformed global config should degrade to
 * defaults, not break every `aw` launch.
 */
export async function readGlobalConfig(configRoot: string = getConfigRoot()): Promise<GlobalConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(configRoot, 'config.json'), 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const result = GlobalConfigSchema.safeParse(parsed);
  return result.success ? result.data : {};
}

/** The channel defaults to merge with a brief's own: config.json's `channels` if set, else the fallback. */
export async function resolveDefaultChannels(configRoot?: string): Promise<string[]> {
  const config = await readGlobalConfig(configRoot);
  return config.channels && config.channels.length > 0 ? config.channels : FALLBACK_DEFAULT_CHANNELS;
}
