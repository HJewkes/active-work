import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { BriefFrontmatterSchema, type BriefFrontmatter } from '../schemas/brief.js';
import { expandTilde } from '../utils/paths.js';
import { NotFoundError } from '../errors.js';
import { readMarkdownWithSchema } from '../bootstrap/prompt.js';

/** List initiative slugs (immediate, non-dotfile subdirectories of the root). */
export async function listInitiativeSlugs(
  activeRoot: string,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(activeRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/**
 * Resolve a user-supplied slug (exact or unique prefix) to a full slug.
 * Throws NotFoundError on no match, and on an ambiguous prefix.
 */
export async function resolveSlug(
  activeRoot: string,
  input: string,
): Promise<string> {
  const slugs = await listInitiativeSlugs(activeRoot);
  if (slugs.includes(input)) return input;
  const matches = slugs.filter((s) => s.startsWith(input));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new NotFoundError(
      `Ambiguous slug '${input}'. Candidates: ${matches.join(', ')}`,
    );
  }
  if (slugs.length === 0) {
    throw new NotFoundError(`No initiatives found under ${activeRoot}`);
  }
  throw new NotFoundError(
    `No initiative matches '${input}'. Known: ${slugs.join(', ')}`,
  );
}

/** True when `child` is `parent` itself or nested beneath it. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Canonicalize a path via `realpath`, falling back to a lexical resolve when
 * the path doesn't exist yet. Needed because `process.cwd()` returns the
 * symlink-resolved path on macOS (e.g. `/var` → `/private/var`) while a brief
 * may store the un-resolved form — matching them requires both canonicalized.
 */
async function canonicalize(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export interface CwdMatch {
  slug: string;
  worktreePath: string;
}

/**
 * Resolve an initiative from a working directory by matching it against every
 * initiative's worktree paths. When `cwd` sits inside more than one worktree
 * (e.g. nested checkouts) the deepest — longest — worktree path wins. Returns
 * the matched slug and (display-form) worktree path, or null when nothing
 * matches or two initiatives tie at the same depth (ambiguous → fall back to
 * the picker).
 *
 * Both sides are canonicalized with `realpath` so symlinked paths still match.
 * Relative worktree paths are skipped, since they cannot be compared against
 * an absolute cwd deterministically.
 */
export async function resolveSlugFromCwd(
  activeRoot: string,
  cwd: string,
): Promise<CwdMatch | null> {
  const resolvedCwd = await canonicalize(cwd);
  const slugs = await listInitiativeSlugs(activeRoot);
  let best: { slug: string; worktreePath: string; depth: number } | null = null;
  let tiedAtBest = false;

  for (const slug of slugs) {
    const briefPath = path.join(activeRoot, slug, 'brief.md');
    let brief: BriefFrontmatter;
    try {
      ({ frontmatter: brief } = await readMarkdownWithSchema(
        briefPath,
        BriefFrontmatterSchema,
      ));
    } catch {
      continue;
    }
    for (const entry of Object.values(brief.worktrees ?? {})) {
      const displayPath = expandTilde(entry.path);
      if (!path.isAbsolute(displayPath)) continue;
      const canonical = await canonicalize(displayPath);
      if (!isInside(resolvedCwd, canonical)) continue;
      const depth = canonical.length;
      if (best === null || depth > best.depth) {
        best = { slug, worktreePath: displayPath, depth };
        tiedAtBest = false;
      } else if (depth === best.depth && slug !== best.slug) {
        tiedAtBest = true;
      }
    }
  }

  if (best === null || tiedAtBest) return null;
  return { slug: best.slug, worktreePath: best.worktreePath };
}
