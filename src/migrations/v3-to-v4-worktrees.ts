import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import YAML from 'yaml';
import { ArtifactsSchema, type WorktreeEntry } from '../schemas/artifacts.js';
import { writeYaml } from '../utils/yaml-io.js';
import { atomicWrite } from '../utils/fs-atomic.js';
import type { Migration } from './types.js';

/**
 * v3 → v4 (AW-67): move `brief.worktrees` into `artifacts.yml`.
 *
 * A worktree had two homes: a curated map in the brief keyed by label, and the
 * list `wrap` sweeps from git. They now share one list, with `name` marking the
 * entries an operator registered — see `src/schemas/artifacts.ts`.
 *
 * Per initiative:
 * - each `brief.worktrees[label]` becomes an `artifacts.worktrees[]` entry with
 *   `name: label` and its `default` flag preserved
 * - a swept entry already at that path is *promoted* in place rather than
 *   duplicated, so the pairing survives a wrap that ran before the migration
 * - `repo` is required by the schema and the brief never carried one, so a
 *   promoted entry keeps the repo the sweep found and a fresh entry falls back
 *   to its own path
 * - `worktrees` is removed from the brief frontmatter
 *
 * Idempotent: a brief with no `worktrees` key is left untouched, and a second
 * run finds nothing to move. Only the frontmatter is rewritten; brief prose is
 * preserved byte-for-byte.
 */

interface RawBriefWorktree {
  path?: unknown;
  default?: unknown;
}

/** Same-path comparison without tilde expansion surprises. */
function normalize(value: string): string {
  const expanded = value.startsWith('~')
    ? path.join(process.env.HOME ?? '', value.slice(1))
    : value;
  return path.resolve(expanded);
}

function toEntries(raw: unknown): Array<{ name: string; path: string; default: boolean }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: Array<{ name: string; path: string; default: boolean }> = [];
  for (const [name, value] of Object.entries(raw as Record<string, RawBriefWorktree>)) {
    const wtPath = value?.path;
    if (typeof wtPath !== 'string' || wtPath.length === 0) continue;
    out.push({ name, path: wtPath, default: value?.default === true });
  }
  return out;
}

/**
 * Merge migrated entries into whatever the sweep already recorded. At most one
 * `default` survives: the brief could only express one, but a promoted entry
 * plus a stale flag elsewhere could otherwise produce two and fail validation.
 */
function mergeWorktrees(
  existing: WorktreeEntry[],
  incoming: Array<{ name: string; path: string; default: boolean }>,
): WorktreeEntry[] {
  const out = existing.map((entry) => ({ ...entry }));
  for (const wt of incoming) {
    const match = out.find(
      (entry) => entry.name === undefined && normalize(entry.path) === normalize(wt.path),
    );
    const target = match ?? { path: wt.path, repo: wt.path };
    target.name = wt.name;
    if (wt.default) target.default = true;
    else delete target.default;
    if (!match) out.push(target);
  }
  if (out.filter((entry) => entry.default === true).length > 1) {
    let kept = false;
    for (const entry of out) {
      if (entry.default !== true) continue;
      if (kept) delete entry.default;
      kept = true;
    }
  }
  return out;
}

async function readArtifacts(file: string): Promise<{
  branches: unknown[];
  stashes: unknown[];
  worktrees: WorktreeEntry[];
}> {
  try {
    const raw = YAML.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    return {
      branches: Array.isArray(raw?.branches) ? raw.branches : [],
      stashes: Array.isArray(raw?.stashes) ? raw.stashes : [],
      worktrees: Array.isArray(raw?.worktrees) ? (raw.worktrees as WorktreeEntry[]) : [],
    };
  } catch {
    return { branches: [], stashes: [], worktrees: [] };
  }
}

/** Returns how many worktrees moved out of this brief. */
async function migrateOne(initiativeDir: string): Promise<number> {
  const briefPath = path.join(initiativeDir, 'brief.md');
  let raw: string;
  try {
    raw = await fs.readFile(briefPath, 'utf8');
  } catch {
    return 0;
  }
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  if (!('worktrees' in data)) return 0;

  const incoming = toEntries(data.worktrees);
  delete data.worktrees;

  if (incoming.length > 0) {
    const artifactsPath = path.join(initiativeDir, 'artifacts.yml');
    const current = await readArtifacts(artifactsPath);
    await writeYaml(
      artifactsPath,
      ArtifactsSchema.parse({
        branches: current.branches,
        stashes: current.stashes,
        worktrees: mergeWorktrees(current.worktrees, incoming),
      }),
      ArtifactsSchema,
    );
  }

  // Rewrite the brief frontmatter only; `matter.stringify` preserves the body.
  await atomicWrite(briefPath, matter.stringify(parsed.content, data));
  return incoming.length;
}

async function initiativeDirs(activeRoot: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(activeRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(activeRoot, entry.name);
    try {
      await fs.access(path.join(dir, 'brief.md'));
      out.push(dir);
    } catch {
      // not an initiative
    }
  }
  return out;
}

export const v3ToV4Worktrees: Migration = {
  from: 3,
  to: 4,
  description: 'Move brief.worktrees into artifacts.yml as named worktree entries',
  async run(activeRoot: string): Promise<void> {
    const moved: string[] = [];
    for (const dir of await initiativeDirs(activeRoot)) {
      const count = await migrateOne(dir);
      if (count > 0) moved.push(`${path.basename(dir)}\t${count} worktree(s)`);
    }
    if (moved.length === 0) return;
    const stamp = new Date().toISOString();
    await fs.appendFile(
      path.join(activeRoot, '.migrations.log'),
      moved.map((line) => `${stamp}\tv3->v4\t${line}\n`).join(''),
      'utf8',
    );
  },
};

export default v3ToV4Worktrees;
