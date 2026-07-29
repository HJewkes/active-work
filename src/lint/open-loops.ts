import path from 'node:path';
import { deriveOpenLoops } from '../sessions/open-loops.js';
import { loadTasks } from './load-tasks.js';
import { DEFAULT_LIMITS, type LintFinding, type LintLimits } from './types.js';

/**
 * A `kind: 'task'` loop closes itself when its task is marked done, because
 * derivation is handed the task list. A `kind: 'pr'` loop has no such luck:
 * `isAutoResolved` can close one, but only when given `mergedPrs`, and
 * bootstrap deliberately withholds that to stay offline on every launch. So a
 * PR loop never closes on its own however long ago its PR merged — it just
 * ages until it trips the cap below, where the generic advice ("resolve with
 * outcome: abandoned") is exactly wrong for work that in fact shipped (AW-74).
 */
function staleLoopAdvice(kind: string): string {
  if (kind === 'pr') {
    return (
      'work it or resolve it explicitly — note that a pr loop can never ' +
      'close itself (loop derivation stays offline and never checks merge ' +
      'state), so if the PR has already merged, resolve it with outcome: ' +
      'done rather than abandoned'
    );
  }
  return 'work it or resolve it with outcome: abandoned';
}

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
      message: `open loop ${loop.ref} ("${loop.text}") is ${loop.ageDays} days old (> ${limits.openLoopMaxAgeDays}) — ${staleLoopAdvice(loop.kind)}`,
    }));
}
