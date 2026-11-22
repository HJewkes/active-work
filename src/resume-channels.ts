import path from 'node:path';
import { resolveSlugFromCwd } from './commands/_open-helpers.js';
import { mergeChannels } from './launcher-args.js';
import { BriefFrontmatterSchema } from './schemas/brief.js';
import { readMarkdownWithSchema } from './bootstrap/prompt.js';
import { readGlobalConfig, resolveDefaultChannels } from './utils/global-config.js';

interface ResumeLocation {
  cwd: string;
  slug?: string;
}

async function briefChannels(activeRoot: string, slug: string): Promise<string[] | undefined> {
  try {
    const briefPath = path.join(activeRoot, slug, 'brief.md');
    const { frontmatter } = await readMarkdownWithSchema(briefPath, BriefFrontmatterSchema);
    return frontmatter.channels;
  } catch {
    return undefined;
  }
}

/**
 * The channels `aw open` would load for the initiative a resumed session
 * belongs to: its session-log slug, else the initiative whose registered
 * worktree contains the session's cwd. With no initiative, only channels the
 * user configured globally apply, so a bare resume never gains the built-in
 * fallback it never asked for.
 */
export async function resolveResumeChannels(
  activeRoot: string,
  location: ResumeLocation,
  configRoot?: string,
): Promise<string[]> {
  const slug = location.slug ?? (await resolveSlugFromCwd(activeRoot, location.cwd))?.slug;
  if (!slug) return (await readGlobalConfig(configRoot)).channels ?? [];
  const defaults = await resolveDefaultChannels(configRoot);
  return mergeChannels(defaults, await briefChannels(activeRoot, slug));
}
