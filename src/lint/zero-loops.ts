import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { SessionFrontmatterSchema, type SessionFrontmatter } from '../schemas/session.js';
import type { LintFinding } from './types.js';

const FRONTMATTER_DELIM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

async function readSessionFrontmatter(filePath: string): Promise<SessionFrontmatter | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const match = FRONTMATTER_DELIM.exec(raw);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = YAML.parse(match[1] ?? '');
  } catch {
    return null;
  }
  const result = SessionFrontmatterSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Warn when a session records an empty ledger — no `next_steps`, no
 * `resolves` — without the `no_loops` marker.
 *
 * An unmarked empty ledger is indistinguishable from a wrap that simply
 * forgot to file anything; `no_loops: true` (written by `wrap --no-loops`) is
 * the only way to say "deliberately clear" instead. `track: 'sidecar'` is
 * exempt: `fold` writes sidecar sessions to import already-discovered work,
 * not to record a wrap-up, so every one of them has an empty ledger with no
 * marker by construction — warning on those would be permanent, unactionable
 * noise.
 *
 * Malformed session files are skipped: this rule is warn-only and must never
 * throw on a broken initiative.
 */
export async function lintZeroLoops(
  slug: string,
  initiativeDir: string,
): Promise<LintFinding[]> {
  const sessionsDir = path.join(initiativeDir, 'sessions');
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }

  const findings: LintFinding[] = [];
  for (const filename of entries.filter((n) => n.endsWith('.md')).sort()) {
    const frontmatter = await readSessionFrontmatter(path.join(sessionsDir, filename));
    if (!frontmatter || frontmatter.track === 'sidecar' || frontmatter.no_loops === true) {
      continue;
    }
    if (frontmatter.next_steps.length > 0 || frontmatter.resolves.length > 0) continue;

    findings.push({
      level: 'warn',
      slug,
      file: path.posix.join('sessions', filename),
      message:
        'session recorded an empty ledger (no next_steps, no resolves) without no_loops: true — ' +
        're-wrap with --no-loops if that was deliberate, or file the loops that were missed',
    });
  }
  return findings;
}
