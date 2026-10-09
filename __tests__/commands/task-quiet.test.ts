import { describe, it, expect } from 'vitest';
import taskAdd from '../../src/commands/task-add.js';
import taskEdit from '../../src/commands/task-edit.js';
import taskDone from '../../src/commands/task-done.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import type { CommandContext } from '../../src/registry/index.js';

function ctx(activeRoot: string, format: 'human' | 'json' = 'human'): CommandContext {
  return { activeRoot, warnings: [], format };
}

const SLUG = 'sample-initiative';

describe('task --quiet', () => {
  it('task add prints "<id> created"', async () => {
    await withTempActiveRoot(async (root) => {
      const out = await taskAdd.run({ slug: SLUG, title: 'New', quiet: true }, ctx(root));
      expect(out).toMatch(/^SI-\d+ created\n$/);
    });
  });

  it('task done prints "<id> done <date>"', async () => {
    await withTempActiveRoot(async (root) => {
      const out = await taskDone.run({ slug: SLUG, id: 'SI-1', quiet: true }, ctx(root));
      expect(out).toMatch(/^SI-1 done \d{4}-\d{2}-\d{2}\n$/);
    });
  });

  it.each([
    ['a field edit', { field: 'title', value: 'Renamed' }, 'SI-1 edited: title\n'],
    ['--append', { append: 'one more' }, 'SI-1 edited: notes\n'],
    ['--add-tag', { add_tag: 'fresh' }, 'SI-1 edited: +tag fresh\n'],
    ['--remove-tag', { remove_tag: 'example' }, 'SI-1 edited: -tag example\n'],
    [
      'combined flags',
      { append: 'line', add_tag: 'fresh', remove_tag: 'example' },
      'SI-1 edited: notes, +tag fresh, -tag example\n',
    ],
    ['a no-op tag add', { add_tag: 'example' }, 'SI-1 unchanged\n'],
  ])('task edit names what changed for %s', async (_label, edit, expected) => {
    await withTempActiveRoot(async (root) => {
      const out = await taskEdit.run({ slug: SLUG, id: 'SI-1', ...edit, quiet: true }, ctx(root));
      expect(out).toBe(expected);
    });
  });

  it('keeps the full task object when the caller asks for JSON, as MCP does', async () => {
    await withTempActiveRoot(async (root) => {
      const out = await taskDone.run({ slug: SLUG, id: 'SI-1', quiet: true }, ctx(root, 'json'));
      expect(out).toMatchObject({ id: 'SI-1', status: 'done' });
    });
  });
});
