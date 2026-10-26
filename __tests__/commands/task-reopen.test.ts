import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import taskAdd from '../../src/commands/task-add.js';
import taskDone from '../../src/commands/task-done.js';
import taskEdit from '../../src/commands/task-edit.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json', cwd: activeRoot };
}

async function readTask(root: string, id: string): Promise<Record<string, unknown>> {
  const file = path.join(root, SLUG, 'tasks', `${id}.yml`);
  return YAML.parse(await fs.readFile(file, 'utf8'));
}

describe('reopening a done task', () => {
  it('clears done_at and leaves task add working in the initiative', async () => {
    await withTempActiveRoot(async (root) => {
      expect((await readTask(root, 'SI-2')).done_at).toBe('2026-05-10');

      const reopened = await taskEdit.run(
        { slug: SLUG, id: 'SI-2', field: 'status', value: 'open' },
        ctx(root),
      );
      const added = await taskAdd.run({ slug: SLUG, title: 'After reopen' }, ctx(root));

      expect(reopened.done_at).toBeNull();
      expect((await readTask(root, 'SI-2')).done_at).toBeNull();
      expect(added.title).toBe('After reopen');
    });
  });

  it('task done still stamps done_at on an open task', async () => {
    await withTempActiveRoot(async (root) => {
      const done = await taskDone.run({ slug: SLUG, id: 'SI-1' }, ctx(root));

      expect(done.done_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect((await readTask(root, 'SI-1')).done_at).toBe(done.done_at);
    });
  });
});
