import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readRawFrontmatter } from '../utils/gray-matter-io.js';
import { extractSourceReferences, listSources } from '../sources/list.js';
import type { LintFinding } from './types.js';

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Flag drift between `sources/` on disk and the references hand-written in
 * `brief.md`.
 *
 * The listing itself is always derived from the directory (`source list`), so
 * this rule is about the prose: a brief that keeps a References section is
 * making a promise it has to keep. Two ways it breaks:
 *
 * - it links a `sources/...md` that no longer exists (rename, delete, typo);
 * - a file lands in `sources/` and never gets mentioned — the case that
 *   actually bit us, where the References list silently under-reported what
 *   the initiative knew.
 *
 * The unmentioned-file rule only fires once a brief references *some* source,
 * because that is the signal it maintains a list at all. Briefs that never
 * link into `sources/` are not silently broken and must not be nagged.
 */
export async function lintSources(slug: string, initiativeDir: string): Promise<LintFinding[]> {
  const briefPath = path.join(initiativeDir, 'brief.md');
  if (!(await fileExists(briefPath))) return [];

  const { body } = await readRawFrontmatter(briefPath);
  const referenced = extractSourceReferences(body);
  if (referenced.length === 0) return [];

  const findings: LintFinding[] = [];

  for (const ref of referenced) {
    const target = path.join(initiativeDir, 'sources', ref);
    if (!(await fileExists(target))) {
      findings.push({
        level: 'warn',
        slug,
        file: 'brief.md',
        message: `references sources/${ref}, which does not exist — fix the link or restore the file`,
      });
    }
  }

  const onDisk = await listSources(initiativeDir);
  const missing = onDisk
    .map((entry) => entry.filename)
    .filter((filename) => !referenced.includes(filename));

  if (missing.length > 0) {
    findings.push({
      level: 'warn',
      slug,
      file: 'brief.md',
      message:
        `references some sources but not ${missing.map((m) => `sources/${m}`).join(', ')} — ` +
        `the hand-written list drifted; \`active-work source list ${slug}\` derives it from the directory`,
    });
  }

  return findings;
}
