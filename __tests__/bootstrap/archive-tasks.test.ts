import { promises as fs, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { archiveStaleTasks } from '../../src/bootstrap/archive-tasks.js';

const NOW = new Date('2026-07-01T00:00:00Z');

function taskYaml(fields: Record<string, string | number | null>): string {
  return (
    Object.entries(fields)
      .map(([k, v]) => `${k}: ${v === null ? 'null' : typeof v === 'number' ? v : `'${v}'`}`)
      .join('\n') + '\n'
  );
}

describe('archiveStaleTasks', () => {
  let base: string;
  let initiativeDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'aw-archive-'));
    initiativeDir = path.join(base, 'sample');
    tasksDir = path.join(initiativeDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  async function writeTask(filename: string, fields: Record<string, string | number | null>): Promise<void> {
    await fs.writeFile(path.join(tasksDir, filename), taskYaml(fields), 'utf8');
  }

  it('archives done tasks older than the retention window', async () => {
    await writeTask('AW-1.yml', {
      id: 'AW-1', title: 'Old done', priority: 1, status: 'done',
      created: '2026-01-01', updated: '2026-05-01', done_at: '2026-05-01', // ~60d before NOW
    });

    const archived = await archiveStaleTasks(initiativeDir, { retentionDays: 30, now: NOW });

    expect(archived).toEqual(['AW-1']);
    expect(existsSync(path.join(tasksDir, 'AW-1.yml'))).toBe(false);
    expect(existsSync(path.join(tasksDir, 'archive', 'AW-1.yml'))).toBe(true);
  });

  it('keeps done tasks inside the retention window', async () => {
    await writeTask('AW-2.yml', {
      id: 'AW-2', title: 'Recent done', priority: 1, status: 'done',
      created: '2026-06-01', updated: '2026-06-20', done_at: '2026-06-20', // ~11d before NOW
    });

    const archived = await archiveStaleTasks(initiativeDir, { retentionDays: 30, now: NOW });

    expect(archived).toEqual([]);
    expect(existsSync(path.join(tasksDir, 'AW-2.yml'))).toBe(true);
  });

  it('never archives open tasks or done tasks with no done_at', async () => {
    await writeTask('AW-3.yml', {
      id: 'AW-3', title: 'Open old', priority: 1, status: 'open',
      created: '2026-01-01', updated: '2026-01-01', done_at: null,
    });
    await writeTask('AW-4.yml', {
      id: 'AW-4', title: 'Done no date', priority: 2, status: 'done',
      created: '2026-01-01', updated: '2026-01-01', done_at: null,
    });

    const archived = await archiveStaleTasks(initiativeDir, { retentionDays: 30, now: NOW });

    expect(archived).toEqual([]);
    expect(existsSync(path.join(tasksDir, 'AW-3.yml'))).toBe(true);
    expect(existsSync(path.join(tasksDir, 'AW-4.yml'))).toBe(true);
  });

  it('skips malformed task files without throwing', async () => {
    await fs.writeFile(path.join(tasksDir, 'bad.yml'), 'not: [valid task\n', 'utf8');
    await writeTask('AW-5.yml', {
      id: 'AW-5', title: 'Old done', priority: 1, status: 'done',
      created: '2026-01-01', updated: '2026-01-01', done_at: '2026-01-01',
    });

    const archived = await archiveStaleTasks(initiativeDir, { retentionDays: 30, now: NOW });

    expect(archived).toEqual(['AW-5']);
    expect(existsSync(path.join(tasksDir, 'bad.yml'))).toBe(true); // left in place
  });

  it('is disabled when retentionDays <= 0', async () => {
    await writeTask('AW-6.yml', {
      id: 'AW-6', title: 'Old done', priority: 1, status: 'done',
      created: '2026-01-01', updated: '2026-01-01', done_at: '2026-01-01',
    });

    const archived = await archiveStaleTasks(initiativeDir, { retentionDays: 0, now: NOW });

    expect(archived).toEqual([]);
    expect(existsSync(path.join(tasksDir, 'AW-6.yml'))).toBe(true);
  });

  it('returns [] when there is no tasks directory', async () => {
    const archived = await archiveStaleTasks(path.join(base, 'nonexistent'), {
      retentionDays: 30,
      now: NOW,
    });
    expect(archived).toEqual([]);
  });
});
