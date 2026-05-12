import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintTasks } from '../../src/lint/task.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const LIMITS = {
  handoffMaxBodyLines: 100,
  briefMaxBodyLines: 150,
  taskNotesMaxLines: 5,
};

describe('lintTasks', () => {
  it('returns no findings for fixture tasks (short notes)', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const findings = await lintTasks('sample-initiative', dir);
      expect(findings).toEqual([]);
    });
  });

  it('returns no findings when the tasks dir is missing', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      await fs.rm(path.join(dir, 'tasks'), { recursive: true, force: true });
      const findings = await lintTasks('sample-initiative', dir);
      expect(findings).toEqual([]);
    });
  });

  it('warns when a task notes block exceeds the cap', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const longNotes = Array.from({ length: 8 }, (_, i) => `  note ${i + 1}`).join('\n');
      const yml = [
        'id: SI-9',
        'title: Big notes',
        'priority: 1',
        'status: open',
        'created: 2026-05-09',
        'updated: 2026-05-10',
        'done_at: null',
        'notes: |',
        longNotes,
        '',
      ].join('\n');
      await fs.writeFile(path.join(dir, 'tasks', 'SI-9.yml'), yml, 'utf8');

      const findings = await lintTasks('sample-initiative', dir, LIMITS);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        level: 'warn',
        slug: 'sample-initiative',
        file: 'tasks/SI-9.yml',
      });
      expect(findings[0].message).toContain('task SI-9 notes are 8 lines');
      expect(findings[0].message).toContain('done_when');
    });
  });

  it('skips files that fail to parse', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      await fs.writeFile(path.join(dir, 'tasks', 'broken.yml'), ':\n :\n  bad yaml: [\n', 'utf8');
      const findings = await lintTasks('sample-initiative', dir, LIMITS);
      expect(findings).toEqual([]);
    });
  });

  it('ignores tasks without notes', async () => {
    await withTempActiveRoot(async (root) => {
      const dir = path.join(root, 'sample-initiative');
      const yml = [
        'id: SI-3',
        'title: No notes',
        'priority: 2',
        'status: open',
        'created: 2026-05-09',
        'updated: 2026-05-10',
        'done_at: null',
        '',
      ].join('\n');
      await fs.writeFile(path.join(dir, 'tasks', 'SI-3.yml'), yml, 'utf8');
      const findings = await lintTasks('sample-initiative', dir, LIMITS);
      expect(findings).toEqual([]);
    });
  });
});
