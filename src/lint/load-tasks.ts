import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TaskSchema, type Task } from '../schemas/task.js';
import { readYaml } from '../utils/yaml-io.js';

/**
 * Load every task under `<initiativeDir>/tasks/*.yml`.
 *
 * Shared by lint and doctor: both need `kind: 'task'` loops matched against
 * real tasks, and both are best-effort consumers — a malformed task file is
 * skipped rather than thrown, since neither is the source of truth for task
 * validity (schema-validating writers are).
 */
export async function loadTasks(initiativeDir: string): Promise<Task[]> {
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
