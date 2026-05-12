import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { DEFAULT_LIMITS, type LintFinding, type LintLimits } from './types.js';

function countNotesLines(notes: string): number {
  const lines = notes.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.length;
}

async function listTaskFiles(tasksDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(tasksDir);
    return entries.filter((n) => n.endsWith('.yml')).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Walk `tasks/*.yml` and warn when a task's `notes` field exceeds the limit.
 *
 * Files that fail to parse are silently skipped — those are hard failures
 * surfaced by reader-side schema validation elsewhere; lint is warn-only.
 */
export async function lintTasks(
  slug: string,
  initiativeDir: string,
  limits: LintLimits = DEFAULT_LIMITS,
): Promise<LintFinding[]> {
  const tasksDir = path.join(initiativeDir, 'tasks');
  const files = await listTaskFiles(tasksDir);
  const findings: LintFinding[] = [];

  for (const filename of files) {
    const filePath = path.join(tasksDir, filename);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = YAML.parse(raw);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    const notes = record.notes;
    if (typeof notes !== 'string' || notes.length === 0) continue;

    const lineCount = countNotesLines(notes);
    if (lineCount <= limits.taskNotesMaxLines) continue;

    const id = typeof record.id === 'string' ? record.id : filename.replace(/\.yml$/, '');
    findings.push({
      level: 'warn',
      slug,
      file: path.posix.join('tasks', filename),
      message: `task ${id} notes are ${lineCount} lines — consider summarizing into done_when or a sources/ file`,
    });
  }

  return findings;
}
