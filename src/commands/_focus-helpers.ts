import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  BriefFrontmatterSchema,
  type BriefFrontmatter,
} from '../schemas/brief.js';
import { getActiveRoot, getInitiativeDir } from '../utils/paths.js';
import { readFrontmatter } from '../utils/gray-matter-io.js';

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
    const { frontmatter, body } = await readFrontmatter(
      briefPath,
      BriefFrontmatterSchema,
    );
    briefs.push({ slug: name, briefPath, frontmatter, body });
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
