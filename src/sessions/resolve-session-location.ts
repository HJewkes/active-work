import { promises as fs } from 'node:fs';
import path from 'node:path';
import { claudeTranscriptRoots } from '@titan-design/session-read';
import { ValidationError } from '../errors.js';
import { resolveProfileDir } from '../launcher-profile.js';
import { listInitiativeSlugs, resolveLaunchCwd } from '../commands/_open-helpers.js';
import { parseFrontmatter } from '../utils/gray-matter-io.js';

export interface ResolvedSessionLocation {
  cwd: string;
  source: 'active-work' | 'claude-projects';
  /** Set only when `source` is `active-work`. */
  slug?: string;
  /** Set only when the session lives outside the default config dir. */
  configDir?: string;
}

/**
 * Search every initiative's `sessions/*.md` for a frontmatter `session_id`
 * match. Filenames carry the id as a suffix (`session-file.ts`), so filtering
 * on that first avoids parsing every session file, but the frontmatter is
 * still the source of truth — a suffix match alone isn't proof.
 */
async function findInActiveWork(
  activeRoot: string,
  sessionId: string,
): Promise<{ slug: string; cwd: string } | null> {
  for (const slug of await listInitiativeSlugs(activeRoot)) {
    const sessionsDir = path.join(activeRoot, slug, 'sessions');
    let filenames: string[];
    try {
      filenames = await fs.readdir(sessionsDir);
    } catch {
      continue;
    }
    for (const filename of filenames) {
      if (!filename.endsWith('.md') || !filename.includes(sessionId)) continue;
      let raw: string;
      try {
        raw = await fs.readFile(path.join(sessionsDir, filename), 'utf8');
      } catch {
        continue;
      }
      const { data } = parseFrontmatter(raw);
      if (data.session_id === sessionId) {
        return { slug, cwd: resolveLaunchCwd(activeRoot, slug) };
      }
    }
  }
  return null;
}

interface TranscriptRoot {
  root: string;
  /** Null for the default config dir (and the test override), where the env must stay untouched. */
  configDir: string | null;
}

/** Every Claude config dir's transcript store. `CLAUDE_PROJECTS_ROOT` narrows it to one for tests. */
function transcriptRoots(): TranscriptRoot[] {
  const override = process.env.CLAUDE_PROJECTS_ROOT;
  if (override) return [{ root: override, configDir: null }];
  return claudeTranscriptRoots().map(({ root, account }) => ({
    root,
    configDir: account === 'default' ? null : path.dirname(root),
  }));
}

/** The first `cwd` field found in a transcript's JSONL lines, if any. */
async function extractCwd(filePath: string): Promise<string | null> {
  const raw = await fs.readFile(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record && typeof record === 'object') {
      const cwd = (record as Record<string, unknown>).cwd;
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    }
  }
  return null;
}

interface TranscriptMatch {
  cwd: string;
  configDir: string | null;
}

/**
 * Claude Code names each transcript file after its session id
 * (`<project-dir>/<session_id>.jsonl`), so the lookup is a direct filename
 * match across project dirs rather than a scan of every transcript's content.
 * Returns one match per config dir that holds the session.
 */
async function findTranscripts(sessionId: string): Promise<TranscriptMatch[]> {
  const matches: TranscriptMatch[] = [];
  for (const { root, configDir } of transcriptRoots()) {
    const cwd = await findInRoot(root, sessionId);
    if (cwd) matches.push({ cwd, configDir });
  }
  return matches;
}

async function findInRoot(root: string, sessionId: string): Promise<string | null> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(root);
  } catch {
    return null;
  }
  const targetName = `${sessionId}.jsonl`;
  for (const dir of projectDirs) {
    const candidate = path.join(root, dir, targetName);
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    const cwd = await extractCwd(candidate);
    if (cwd) return cwd;
  }
  return null;
}

function describeConfigDir(match: TranscriptMatch): string {
  return match.configDir ?? '~/.claude';
}

/** The config dir of the profile the initiative declares, if its brief names one. */
async function declaredConfigDir(activeRoot: string, slug: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(activeRoot, slug, 'brief.md'), 'utf8');
    const { profile } = parseFrontmatter(raw).data;
    return typeof profile === 'string' ? resolveProfileDir(profile) : null;
  } catch {
    return null;
  }
}

/** One config dir, or a refusal to guess when several hold the same session id. */
function pickMatch(
  sessionId: string,
  matches: TranscriptMatch[],
  preferred: string | null,
): TranscriptMatch | null {
  if (matches.length <= 1) return matches[0] ?? null;
  const named = preferred ? matches.find((m) => m.configDir === preferred) : undefined;
  if (named) return named;
  const where = matches.map(describeConfigDir).join(' and ');
  throw new ValidationError(
    `Session '${sessionId}' exists under more than one config dir (${where}); ` +
      'remove one copy or set CLAUDE_CONFIG_DIR yourself and run `claude --resume`.',
  );
}

/**
 * Resolve the working directory a session id belongs to: active-work's own
 * session log first (giving the initiative's directory, where `aw` launches
 * every session), then a direct filename match under every config dir's `projects` for
 * sessions active-work never tracked — there the transcript's recorded `cwd`
 * is the answer, since such a session may have run anywhere. `configDir` is
 * set when the transcript lives outside the default config dir.
 */
export async function resolveSessionLocation(
  activeRoot: string,
  sessionId: string,
): Promise<ResolvedSessionLocation | null> {
  const viaActiveWork = await findInActiveWork(activeRoot, sessionId);
  const matches = await findTranscripts(sessionId);
  if (viaActiveWork) {
    const preferred = await declaredConfigDir(activeRoot, viaActiveWork.slug);
    const match = pickMatch(sessionId, matches, preferred);
    return {
      cwd: viaActiveWork.cwd,
      source: 'active-work',
      slug: viaActiveWork.slug,
      ...(match?.configDir ? { configDir: match.configDir } : {}),
    };
  }
  const match = pickMatch(sessionId, matches, null);
  if (!match) return null;
  return {
    cwd: match.cwd,
    source: 'claude-projects',
    ...(match.configDir ? { configDir: match.configDir } : {}),
  };
}
