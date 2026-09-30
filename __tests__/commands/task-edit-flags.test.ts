import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import taskEdit from '../../src/commands/task-edit.js';
import { invokeTool } from '../../src/server/mcp.js';
import '../../src/commands/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import { UsageError } from '../../src/errors.js';
import type { CommandContext } from '../../src/registry/index.js';
import type { Task } from '../../src/schemas/task.js';

const SLUG = 'sample-initiative';
const ID = 'SI-7';

const NOTES_BLOCK = `notes: |
  First line: with a colon

    indented # not a comment
  - last line
`;
const MULTI_LINE_NOTES = 'First line: with a colon\n\n  indented # not a comment\n- last line\n';

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

function taskFile(root: string): string {
  return path.join(root, SLUG, 'tasks', `${ID}.yml`);
}

async function seedTask(root: string, overrides: Partial<Task> = {}): Promise<string> {
  const task = {
    id: ID,
    title: 'Synthetic task',
    priority: 7,
    done_when: 'The flags work',
    status: 'open',
    tags: ['alpha', 'beta', 'gamma'],
    notes: MULTI_LINE_NOTES,
    created: '2026-01-02',
    updated: '2026-01-03',
    done_at: null,
    ...overrides,
  };
  await fs.writeFile(taskFile(root), YAML.stringify(task));
  return fs.readFile(taskFile(root), 'utf8');
}

async function readTask(root: string): Promise<Task> {
  return YAML.parse(await fs.readFile(taskFile(root), 'utf8')) as Task;
}

function edit(root: string, flags: Record<string, unknown>, context = ctx(root)): Promise<Task> {
  return taskEdit.run({ slug: SLUG, id: ID, ...flags }, context);
}

function untouchedFields(task: Task): Partial<Task> {
  const { title, done_when, priority, status, created, done_at } = task;
  return { title, done_when, priority, status, created, done_at };
}

const SEEDED_FIELDS = {
  title: 'Synthetic task',
  done_when: 'The flags work',
  priority: 7,
  status: 'open',
  created: '2026-01-02',
  done_at: null,
};

describe('task.edit --append', () => {
  it('keeps every line of a multi-line block scalar byte for byte and adds exactly one', async () => {
    await withTempActiveRoot(async (root) => {
      const before = await seedTask(root);
      expect(before).toContain(NOTES_BLOCK);

      await edit(root, { append: 'Appended line' });

      const onDisk = await fs.readFile(taskFile(root), 'utf8');
      expect(onDisk).toContain(`${NOTES_BLOCK}  Appended line\n`);
      expect(onDisk.split('\n')).toHaveLength(before.split('\n').length + 1);
      const after = await readTask(root);
      expect(after.notes).toBe(`${MULTI_LINE_NOTES}Appended line\n`);
      expect(after.tags).toEqual(['alpha', 'beta', 'gamma']);
      expect(untouchedFields(after)).toEqual(SEEDED_FIELDS);
    });
  });

  it('keeps the value of a line longer than the writer folds at', async () => {
    await withTempActiveRoot(async (root) => {
      const notes = `Short\nLong ${'word '.repeat(30)}end\n`;
      await seedTask(root, { notes });

      await edit(root, { append: 'Appended line' });

      expect((await readTask(root)).notes).toBe(`${notes}Appended line\n`);
    });
  });

  it('stamps updated the way the field form does', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);

      const result = await edit(root, { append: 'Appended line' });

      const viaField = await edit(root, { field: 'title', value: 'Renamed' });
      expect(result.updated).toBe(viaField.updated);
      expect(result.updated).not.toBe('2026-01-03');
      expect((await readTask(root)).updated).toBe(result.updated);
    });
  });

  it('adds a second line to single-line notes without a trailing newline', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, { notes: 'Only line' });

      await edit(root, { append: 'Second line' });

      expect((await readTask(root)).notes).toBe('Only line\nSecond line');
    });
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])('writes the text as the only line when notes are %s', async (_label, notes) => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, { notes });

      await edit(root, { append: 'First line' });

      const after = await readTask(root);
      expect(after.notes).toBe('First line');
      expect(untouchedFields(after)).toEqual(SEEDED_FIELDS);
    });
  });

  it.each([
    ['a leading dash', '- item: one'],
    ['a colon and a hash', 'key: value # not a comment'],
    ['quotes', `she said "it's done"`],
    ['surrounding spaces', '  padded  '],
  ])('round-trips text with %s', async (_label, text) => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);

      await edit(root, { append: text });
      const reread = await edit(root, { append: 'after' });

      expect(reread.notes).toBe(`${MULTI_LINE_NOTES}${text}\nafter\n`);
    });
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['multi-line', 'one\ntwo'],
  ])('rejects %s text and leaves the file untouched', async (_label, text) => {
    await withTempActiveRoot(async (root) => {
      const before = await seedTask(root);

      await expect(edit(root, { append: text })).rejects.toBeInstanceOf(UsageError);

      expect(await fs.readFile(taskFile(root), 'utf8')).toBe(before);
    });
  });
});

describe('task.edit --add-tag', () => {
  it('adds one tag at the end of an existing list', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      const context = ctx(root);

      await edit(root, { add_tag: 'delta' }, context);

      const after = await readTask(root);
      expect(after.tags).toEqual(['alpha', 'beta', 'gamma', 'delta']);
      expect(after.notes).toBe(MULTI_LINE_NOTES);
      expect(untouchedFields(after)).toEqual(SEEDED_FIELDS);
      expect(context.warnings).toEqual([]);
    });
  });

  it('trims the tag before comparing and storing it', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);

      await edit(root, { add_tag: ' delta ' });
      await edit(root, { remove_tag: ' alpha ' });

      expect((await readTask(root)).tags).toEqual(['beta', 'gamma', 'delta']);
    });
  });

  it('starts the list on a task with no tags', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, { tags: undefined });

      await edit(root, { add_tag: 'delta' });

      expect((await readTask(root)).tags).toEqual(['delta']);
    });
  });

  it('says so and changes nothing when the tag is already present', async () => {
    await withTempActiveRoot(async (root) => {
      const before = await seedTask(root);
      const context = ctx(root);

      const result = await edit(root, { add_tag: 'beta' }, context);

      expect(await fs.readFile(taskFile(root), 'utf8')).toBe(before);
      expect(result.tags).toEqual(['alpha', 'beta', 'gamma']);
      expect(context.warnings).toEqual(['Tag already present, nothing added: beta']);
    });
  });

  it.each([
    ['an empty tag', ' '],
    ['a comma-separated list', 'delta,epsilon'],
  ])('rejects %s and leaves the file untouched', async (_label, tag) => {
    await withTempActiveRoot(async (root) => {
      const before = await seedTask(root);

      await expect(edit(root, { add_tag: tag })).rejects.toBeInstanceOf(UsageError);
      await expect(edit(root, { remove_tag: tag })).rejects.toBeInstanceOf(UsageError);

      expect(await fs.readFile(taskFile(root), 'utf8')).toBe(before);
    });
  });
});

describe('task.edit --remove-tag', () => {
  it('removes one tag and keeps the rest in order', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      const context = ctx(root);

      await edit(root, { remove_tag: 'beta' }, context);

      const after = await readTask(root);
      expect(after.tags).toEqual(['alpha', 'gamma']);
      expect(after.notes).toBe(MULTI_LINE_NOTES);
      expect(untouchedFields(after)).toEqual(SEEDED_FIELDS);
      expect(context.warnings).toEqual([]);
    });
  });

  it('says so and changes nothing when the tag is absent', async () => {
    await withTempActiveRoot(async (root) => {
      const before = await seedTask(root);
      const context = ctx(root);

      await edit(root, { remove_tag: 'delta' }, context);

      expect(await fs.readFile(taskFile(root), 'utf8')).toBe(before);
      expect(context.warnings).toEqual(['Tag not present, nothing removed: delta']);
    });
  });

  it.each([
    [
      'prints the no-op notice to stderr in human mode',
      'human',
      ['Tag not present, nothing removed: delta\n'],
    ],
    ['keeps stderr clean in json mode', 'json', []],
  ] as const)('%s', async (_label, format, expected) => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root);
      const written: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => written.push(chunk) > 0) as typeof original;

      try {
        await edit(root, { remove_tag: 'delta' }, { ...ctx(root), format });
      } finally {
        process.stderr.write = original;
      }

      expect(written).toEqual(expected);
    });
  });
});

describe('task.edit with several flags', () => {
  it('applies append, add-tag and remove-tag in one write', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, { notes: 'Only line' });

      await edit(root, { append: 'Second line', add_tag: 'delta', remove_tag: 'alpha' });

      const after = await readTask(root);
      expect(after.notes).toBe('Only line\nSecond line');
      expect(after.tags).toEqual(['beta', 'gamma', 'delta']);
    });
  });

  it('still writes the append when the tag flag is a no-op', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, { notes: 'Only line' });
      const context = ctx(root);

      await edit(root, { append: 'Second line', add_tag: 'alpha' }, context);

      const after = await readTask(root);
      expect(after.notes).toBe('Only line\nSecond line');
      expect(after.tags).toEqual(['alpha', 'beta', 'gamma']);
      expect(context.warnings).toEqual(['Tag already present, nothing added: alpha']);
    });
  });

  it('rejects adding and removing the same tag', async () => {
    await withTempActiveRoot(async (root) => {
      const before = await seedTask(root);

      await expect(edit(root, { add_tag: 'beta', remove_tag: 'beta' })).rejects.toBeInstanceOf(
        UsageError,
      );

      expect(await fs.readFile(taskFile(root), 'utf8')).toBe(before);
    });
  });
});

describe('task.edit call shape', () => {
  it.each([
    ['field form mixed with --append', { field: 'notes', value: 'x', append: 'y' }],
    ['field form mixed with --add-tag', { field: 'tags', value: 'x', add_tag: 'y' }],
    ['field form mixed with --remove-tag', { field: 'tags', value: 'x', remove_tag: 'alpha' }],
    ['a bare field mixed with --append', { field: 'notes', append: 'y' }],
    ['no operation', {}],
    ['a field with no value', { field: 'notes' }],
    ['a value with no field', { value: 'x' }],
  ])('rejects %s and leaves the file untouched', async (_label, flags) => {
    await withTempActiveRoot(async (root) => {
      const before = await seedTask(root);

      await expect(edit(root, flags)).rejects.toBeInstanceOf(UsageError);

      expect(await fs.readFile(taskFile(root), 'utf8')).toBe(before);
    });
  });

  it('refuses to write a task file it cannot parse', async () => {
    await withTempActiveRoot(async (root) => {
      const broken = 'id: SI-7\ntitle: "unterminated\nnotes: keep me\n';
      await fs.writeFile(taskFile(root), broken);

      await expect(edit(root, { append: 'new line' })).rejects.toThrow(/Failed to parse YAML/);

      expect(await fs.readFile(taskFile(root), 'utf8')).toBe(broken);
    });
  });

  it('refuses to write a task file that fails the schema', async () => {
    await withTempActiveRoot(async (root) => {
      const partial = 'id: SI-7\nnotes: keep me\n';
      await fs.writeFile(taskFile(root), partial);

      await expect(edit(root, { add_tag: 'delta' })).rejects.toThrow(/Schema validation failed/);

      expect(await fs.readFile(taskFile(root), 'utf8')).toBe(partial);
    });
  });
});

describe('task.edit over MCP', () => {
  it('appends and reports a no-op tag through the same tool', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, { notes: 'Only line' });

      const out = await invokeTool('active__task__edit', {
        slug: SLUG,
        id: ID,
        append: 'Second line',
        add_tag: 'alpha',
      });

      expect(out.envelope).toMatchObject({
        ok: true,
        warnings: ['Tag already present, nothing added: alpha'],
      });
      expect((await readTask(root)).notes).toBe('Only line\nSecond line');
    });
  });
});
