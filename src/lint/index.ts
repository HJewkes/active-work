import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { getActiveRoot } from '../utils/paths.js';
import { lintBrief } from './brief.js';
import { lintHandoff } from './handoff.js';
import { lintOpenLoops } from './open-loops.js';
import { lintTasks } from './task.js';
import { DEFAULT_LIMITS, type LintFinding, type LintLimits } from './types.js';

export type { LintFinding, LintLevel, LintLimits } from './types.js';
export { DEFAULT_LIMITS } from './types.js';
export { lintHandoff } from './handoff.js';
export { lintBrief } from './brief.js';
export { lintTasks } from './task.js';
export { lintOpenLoops } from './open-loops.js';

interface LintOptions {
  activeRoot?: string;
  limits?: LintLimits;
  /** Injected for determinism; defaults to `new Date()`. */
  now?: Date;
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
  const now = options.now ?? new Date();
  const initiativeDir = path.join(activeRoot, slug);
  const [handoff, brief, tasks, openLoops] = await Promise.all([
    lintHandoff(slug, initiativeDir, limits),
    lintBrief(slug, initiativeDir, limits),
    lintTasks(slug, initiativeDir, limits),
    lintOpenLoops(slug, initiativeDir, limits, now),
  ]);
  return [...handoff, ...brief, ...tasks, ...openLoops];
}

export async function listInitiativeSlugs(activeRoot: string): Promise<string[]> {
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
    const slugFindings = await lintSlug(slug, {
      activeRoot,
      limits: options.limits,
      now: options.now,
    });
    findings.push(...slugFindings);
  }
  return findings;
}
