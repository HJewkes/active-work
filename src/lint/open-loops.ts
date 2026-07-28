import path from 'node:path';
import { deriveOpenLoops } from '../sessions/open-loops.js';
import { loadTasks } from './load-tasks.js';
import { DEFAULT_LIMITS, type LintFinding, type LintLimits } from './types.js';

/**
 * Warn about open loops that have aged past the cap.
 *
 * Derivation is best-effort by construction (malformed sessions are skipped
 * inside `deriveOpenLoops`), so this rule never throws on a broken initiative
 * — it just reports whatever loops it could derive.
 */
export async function lintOpenLoops(
  slug: string,
  initiativeDir: string,
  limits: LintLimits = DEFAULT_LIMITS,
  now: Date = new Date(),
): Promise<LintFinding[]> {
  const tasks = await loadTasks(initiativeDir);
  const loops = await deriveOpenLoops(initiativeDir, { now, tasks });

  return loops
    .filter((loop) => loop.ageDays > limits.openLoopMaxAgeDays)
    .map((loop) => ({
      level: 'warn',
      slug,
      file: path.posix.join('sessions', `${loop.sessionFile}.md`),
      message: `open loop ${loop.ref} ("${loop.text}") is ${loop.ageDays} days old (> ${limits.openLoopMaxAgeDays}) — work it or resolve it with outcome: abandoned`,
    }));
}
