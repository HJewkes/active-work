import { promises as fs } from 'node:fs';
import path from 'node:path';
import { deriveOpenLoops } from '../sessions/open-loops.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { readYaml } from '../utils/yaml-io.js';
import { DEFAULT_LIMITS, type LintFinding, type LintLimits } from './types.js';

/**
 * Tasks must be supplied to `deriveOpenLoops` or `kind: 'task'` loops never
 * auto-resolve, and the rule warns about loops whose task is already done.
 * Malformed files are skipped: lint is warn-only and must not throw.
 */
async function loadTasks(initiativeDir: string): Promise<Task[]> {
  const tasksDir = path.join(initiativeDir, 'tasks');
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir);
  } catch {
    return [];
  }
  const tasks: Task[] = [];
  for (const filename of entries.filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
    try {
      tasks.push(await readYaml(path.join(tasksDir, filename), TaskSchema));
    } catch {
      // Skip malformed task files.
    }
  }
  return tasks;
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
      message: `open loop ${loop.ref} ("${loop.text}") is ${loop.ageDays} days old (> ${limits.openLoopMaxAgeDays}) — work it or resolve it with outcome: abandoned`,
    }));
}
