import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { z } from 'zod';
import { BriefFrontmatterSchema, type BriefFrontmatter } from '../schemas/brief.js';
import { getActiveRoot, expandTilde } from '../utils/paths.js';
import { readFrontmatter } from '../utils/gray-matter-io.js';
import { defineCommand } from '../registry/index.js';

const argsSchema = z.object({}).strict();

const initiativeSummarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  state: z.enum(['focused', 'backburner', 'paused', 'done']),
  rank: z.number().int().positive().optional(),
  updated: z.string(),
  ship_target: z.string().optional(),
});

const parseErrorSchema = z.object({
  slug: z.string(),
  error: z.string(),
});

const conflictSchema = z.object({
  path: z.string(),
  slugs: z.array(z.string()),
});

const resultSchema = z.object({
  initiatives: z.array(initiativeSummarySchema),
  parse_errors: z.array(parseErrorSchema),
  worktree_conflicts: z.array(conflictSchema),
});


const STATE_ORDER: Record<BriefFrontmatter['state'], number> = {
  focused: 0,
  backburner: 1,
  paused: 2,
  done: 3,
};

export interface ScanEntry {
  slug: string;
  frontmatter: BriefFrontmatter;
}

export interface ScanError {
  slug: string;
  error: string;
}

export interface ScanResult {
  entries: ScanEntry[];
  errors: ScanError[];
}

export async function scanInitiatives(activeRoot: string): Promise<ScanResult> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(activeRoot, { withFileTypes: true });
  } catch {
    return { entries: [], errors: [] };
  }

  const entries: ScanEntry[] = [];
  const errors: ScanError[] = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (dirent.name.startsWith('.')) continue;
    const slug = dirent.name;
    const briefPath = path.join(activeRoot, slug, 'brief.md');
    try {
      await fs.access(briefPath);
    } catch {
      continue;
    }
    try {
      const { frontmatter } = await readFrontmatter(
        briefPath,
        BriefFrontmatterSchema,
      );
      entries.push({ slug, frontmatter });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ slug, error: message });
    }
  }

  return { entries, errors };
}

function detectWorktreeConflicts(
  entries: ScanEntry[],
): Array<{ path: string; slugs: string[] }> {
  const byPath = new Map<string, Set<string>>();
  for (const { slug, frontmatter } of entries) {
    const worktrees = frontmatter.worktrees;
    if (!worktrees) continue;
    for (const entry of Object.values(worktrees)) {
      const resolved = path.resolve(expandTilde(entry.path));
      let bucket = byPath.get(resolved);
      if (!bucket) {
        bucket = new Set();
        byPath.set(resolved, bucket);
      }
      bucket.add(slug);
    }
  }
  const conflicts: Array<{ path: string; slugs: string[] }> = [];
  for (const [resolved, slugs] of byPath) {
    if (slugs.size > 1) {
      conflicts.push({ path: resolved, slugs: [...slugs].sort() });
    }
  }
  conflicts.sort((a, b) => a.path.localeCompare(b.path));
  return conflicts;
}

function compareInitiatives(
  a: ScanEntry,
  b: ScanEntry,
): number {
  const aRank = a.frontmatter.rank ?? Number.POSITIVE_INFINITY;
  const bRank = b.frontmatter.rank ?? Number.POSITIVE_INFINITY;
  if (aRank !== bRank) return aRank - bRank;
  const aState = STATE_ORDER[a.frontmatter.state];
  const bState = STATE_ORDER[b.frontmatter.state];
  if (aState !== bState) return aState - bState;
  return a.slug.localeCompare(b.slug);
}

export default defineCommand({
  name: 'audit',
  description:
    'Cross-initiative summary: lists every initiative, parse failures, and worktree path conflicts.',
  args: argsSchema,
  result: resultSchema,
  cli: {},
  async run() {
    const activeRoot = getActiveRoot();
    const { entries, errors } = await scanInitiatives(activeRoot);
    const initiatives = [...entries]
      .sort(compareInitiatives)
      .map(({ slug, frontmatter }) => ({
        slug,
        title: frontmatter.title,
        state: frontmatter.state,
        ...(frontmatter.rank !== undefined ? { rank: frontmatter.rank } : {}),
        updated: frontmatter.updated,
        ...(frontmatter.ship_target !== undefined
          ? { ship_target: frontmatter.ship_target }
          : {}),
      }));
    return {
      initiatives,
      parse_errors: errors,
      worktree_conflicts: detectWorktreeConflicts(entries),
    };
  },
});
