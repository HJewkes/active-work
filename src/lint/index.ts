import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { getActiveRoot } from '../utils/paths.js';
import { lintBrief } from './brief.js';
import { lintHandoff } from './handoff.js';
import { lintTasks } from './task.js';
import { DEFAULT_LIMITS, type LintFinding, type LintLimits } from './types.js';

export type { LintFinding, LintLevel, LintLimits } from './types.js';
export { DEFAULT_LIMITS } from './types.js';
export { lintHandoff } from './handoff.js';
export { lintBrief } from './brief.js';
export { lintTasks } from './task.js';

interface LintOptions {
  activeRoot?: string;
  limits?: LintLimits;
}

/**
 * Run every lint against a single initiative and concatenate the findings.
 *
 * Per-lint errors propagate; missing artifacts (handled inside each lint)
 * simply yield no findings.
 */
export async function lintSlug(
  slug: string,
  options: LintOptions = {},
): Promise<LintFinding[]> {
  const activeRoot = options.activeRoot ?? getActiveRoot();
  const limits = options.limits ?? DEFAULT_LIMITS;
  const initiativeDir = path.join(activeRoot, slug);
  const [handoff, brief, tasks] = await Promise.all([
    lintHandoff(slug, initiativeDir, limits),
    lintBrief(slug, initiativeDir, limits),
    lintTasks(slug, initiativeDir, limits),
  ]);
  return [...handoff, ...brief, ...tasks];
}

async function listInitiativeSlugs(activeRoot: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(activeRoot, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/**
 * Lint every initiative under `activeRoot` and return the aggregated
 * findings ordered by slug.
 */
export async function lintAll(
  options: LintOptions = {},
): Promise<LintFinding[]> {
  const activeRoot = options.activeRoot ?? getActiveRoot();
  const slugs = await listInitiativeSlugs(activeRoot);
  const findings: LintFinding[] = [];
  for (const slug of slugs) {
    const slugFindings = await lintSlug(slug, { activeRoot, limits: options.limits });
    findings.push(...slugFindings);
  }
  return findings;
}
