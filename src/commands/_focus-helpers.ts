import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BriefFrontmatterSchema,
  type BriefFrontmatter,
} from '../schemas/brief.js';
import { getActiveRoot, getInitiativeDir } from '../utils/paths.js';
import { readRawFrontmatter } from '../utils/gray-matter-io.js';

const DATE_FIELDS = ['updated', 'paused_since'] as const;

/**
 * Normalize fields that YAML may parse as a `Date` (bare `YYYY-MM-DD` values)
 * back into `YYYY-MM-DD` strings so they validate against the schema.
 */
function normalizeDates(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...raw };
  for (const field of DATE_FIELDS) {
    const value = next[field];
    if (value instanceof Date) {
      next[field] = value.toISOString().slice(0, 10);
    }
  }
  return next;
}

export interface InitiativeBrief {
  slug: string;
  briefPath: string;
  frontmatter: BriefFrontmatter;
  body: string;
}

/**
 * Resolve the path to an initiative's `brief.md` for a given slug.
 */
export function briefPathFor(slug: string): string {
  return path.join(getInitiativeDir(slug), 'brief.md');
}

/**
 * Enumerate every initiative directory under the active root by looking for
 * `brief.md`. Returns the parsed and schema-validated frontmatter for each.
 *
 * Directories with no `brief.md` are skipped silently — those are not
 * initiatives. Hidden files (e.g. `.schema-version`) are ignored.
 */
export async function loadAllBriefs(): Promise<InitiativeBrief[]> {
  const root = getActiveRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const briefs: InitiativeBrief[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const briefPath = path.join(root, name, 'brief.md');
    let stat;
    try {
      stat = await fs.stat(briefPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const { frontmatter: rawFront, body } = await readRawFrontmatter(briefPath);
    const normalized = normalizeDates(rawFront);
    const parsed = BriefFrontmatterSchema.safeParse(normalized);
    if (!parsed.success) {
      throw new Error(
        `Frontmatter validation failed for ${briefPath}: ${parsed.error.message}`,
      );
    }
    briefs.push({ slug: name, briefPath, frontmatter: parsed.data, body });
  }
  briefs.sort((a, b) => a.slug.localeCompare(b.slug));
  return briefs;
}

/**
 * Sort a list of slugs into a deterministic order suitable for locking
 * multiple initiatives' brief.md files simultaneously without deadlock.
 */
export function sortSlugs(slugs: Iterable<string>): string[] {
  return [...new Set(slugs)].sort();
}
