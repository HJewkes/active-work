import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { claudeTranscriptRoots } from '@titan-design/session-read';
import { listInitiativeSlugs, resolveLaunchCwd } from '../commands/_open-helpers.js';

export interface ResolvedSessionLocation {
  cwd: string;
  source: 'active-work' | 'claude-projects';
  /** Set only when `source` is `active-work`. */
  slug?: string;
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
      const { data } = matter(raw);
      if (data.session_id === sessionId) {
        return { slug, cwd: resolveLaunchCwd(activeRoot, slug) };
      }
    }
  }
  return null;
}

/** Every Claude config dir's transcript store. `CLAUDE_PROJECTS_ROOT` narrows it to one for tests. */
function transcriptRoots(): string[] {
  const override = process.env.CLAUDE_PROJECTS_ROOT;
  return override ? [override] : claudeTranscriptRoots().map(({ root }) => root);
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

/**
 * Claude Code names each transcript file after its session id
 * (`<project-dir>/<session_id>.jsonl`), so the lookup is a direct filename
 * match across project dirs rather than a scan of every transcript's content.
 */
async function findInClaudeProjects(sessionId: string): Promise<string | null> {
  for (const root of transcriptRoots()) {
    const cwd = await findInRoot(root, sessionId);
    if (cwd) return cwd;
  }
  return null;
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

/**
 * Resolve the working directory a session id belongs to: active-work's own
 * session log first (giving the initiative's directory, where `aw` launches
 * every session), then a direct filename match under every config dir's `projects` for
 * sessions active-work never tracked — there the transcript's recorded `cwd`
 * is the answer, since such a session may have run anywhere.
 */
export async function resolveSessionLocation(
  activeRoot: string,
  sessionId: string,
): Promise<ResolvedSessionLocation | null> {
  const viaActiveWork = await findInActiveWork(activeRoot, sessionId);
  if (viaActiveWork) {
    return { cwd: viaActiveWork.cwd, source: 'active-work', slug: viaActiveWork.slug };
  }
  const viaProjects = await findInClaudeProjects(sessionId);
  if (viaProjects) {
    return { cwd: viaProjects, source: 'claude-projects' };
  }
  return null;
}
