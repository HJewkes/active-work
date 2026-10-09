import path from 'node:path';
import { BUILT_IN_STATUSES, readEdges } from '@titan-design/pm';
import { z } from 'zod';
import { defineCommand, type CommandContext } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { getActiveRoot, getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { today } from '../utils/today.js';
import { NotFoundError, UsageError, ValidationError } from '../errors.js';
import { assertEdgeWrite } from '../tasks/edge-index.js';
import {
  quietOption,
  QuietArg,
  TaskOrLineSchema,
  quietOr,
  type TaskOrLine,
} from './_task-quiet.js';

const EDITABLE_FIELDS = [
  'title',
  'priority',
  'severity',
  'estimate',
  'done_when',
  'tags',
  'notes',
  'status',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

const ArgsSchema = z.object({
  slug: z.string().min(1),
  id: z.string().min(1),
  field: z.string().min(1).optional(),
  value: z.unknown().optional(),
  append: z.string().optional(),
  add_tag: z.string().optional(),
  remove_tag: z.string().optional(),
  parent: z.string().min(1).optional(),
  dep: z.array(z.string().min(1)).optional(),
  remove_dep: z.array(z.string().min(1)).optional(),
  force: z.boolean().optional(),
  quiet: QuietArg,
});

type Args = z.infer<typeof ArgsSchema>;

interface TaskChange {
  changes: Partial<Task>;
  notices: string[];
}

function isEditable(field: string): field is EditableField {
  return (EDITABLE_FIELDS as readonly string[]).includes(field);
}

/**
 * The CLI/MCP dispatcher can't coerce `value` generically because its type
 * depends on `field` at runtime (unlike other commands, where each arg has
 * a fixed zod type). Coerce here, against the field it's actually landing on.
 */
function coerceValue(field: EditableField, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (field === 'priority' || field === 'estimate') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (field === 'tags') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return value;
}

export interface PatchEdit {
  kind: 'patch';
  append?: string;
  addTag?: string;
  removeTag?: string;
  parent?: string;
  addDeps?: string[];
  removeDeps?: string[];
}

type Edit = { kind: 'field'; field: EditableField; value: unknown } | PatchEdit;

function fieldEdit(args: Args): Edit {
  const { field, value } = args;
  if (field === undefined || value === undefined) {
    throw new UsageError('The field form needs both <field> and <value>');
  }
  if (!isEditable(field)) {
    throw new UsageError(
      `Field is not editable: ${field} (allowed: ${EDITABLE_FIELDS.join(', ')})`,
    );
  }
  return { kind: 'field', field, value };
}

function noteLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (text.trim() === '') throw new UsageError('--append needs non-empty text');
  if (/[\r\n]/.test(text)) {
    throw new UsageError('--append takes one line; call it once per line');
  }
  return text;
}

function singleTag(flag: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const tag = raw.trim();
  if (tag === '') throw new UsageError(`${flag} needs a non-empty tag`);
  if (tag.includes(',')) throw new UsageError(`${flag} takes one tag per call: ${tag}`);
  return tag;
}

function patchEdit(args: Args): Edit {
  const append = noteLine(args.append);
  const addTag = singleTag('--add-tag', args.add_tag);
  const removeTag = singleTag('--remove-tag', args.remove_tag);
  if (addTag !== undefined && addTag === removeTag) {
    throw new UsageError(`--add-tag and --remove-tag name the same tag: ${addTag}`);
  }
  const overlap = (args.dep ?? []).filter((id) => args.remove_dep?.includes(id));
  if (overlap.length > 0) {
    throw new UsageError(`--dep and --remove-dep name the same id: ${overlap.join(', ')}`);
  }
  return {
    kind: 'patch',
    append,
    addTag,
    removeTag,
    parent: args.parent,
    addDeps: args.dep,
    removeDeps: args.remove_dep,
  };
}

const PATCH_KEYS = ['append', 'add_tag', 'remove_tag', 'parent', 'dep', 'remove_dep'] as const;

function parseEdit(args: Args): Edit {
  const fieldForm = args.field !== undefined || args.value !== undefined;
  const flagForm = PATCH_KEYS.some((key) => args[key] !== undefined);
  if (fieldForm && flagForm) {
    throw new UsageError(
      'Pass either <field> <value> or --append/--add-tag/--remove-tag/--parent/--dep/--remove-dep, not both',
    );
  }
  if (fieldForm) return fieldEdit(args);
  if (flagForm) return patchEdit(args);
  throw new UsageError(
    'Nothing to edit: pass <field> <value>, --append <text>, --add-tag <tag>, --remove-tag <tag>, ' +
      '--parent <id>, --dep <ids> or --remove-dep <ids>',
  );
}

function appendLine(notes: string | undefined, line: string): string {
  if (notes === undefined || notes === '') return line;
  return notes.endsWith('\n') ? `${notes}${line}\n` : `${notes}\n${line}`;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Writes the edges as fields, starting from readEdges so a tag-only edge is carried over. */
function edgeChange(task: Task, edit: PatchEdit): TaskChange {
  const changes: Partial<Task> = {};
  const notices: string[] = [];
  const { parent, addDeps = [], removeDeps = [] } = edit;
  if (parent !== undefined && parent !== task.parent) changes.parent = parent;
  if (parent !== undefined && parent === task.parent) notices.push(`Parent already ${parent}`);
  const current = readEdges(task).dep;
  for (const id of addDeps.filter((dep) => current.includes(dep))) {
    notices.push(`Dep already present, nothing added: ${id}`);
  }
  for (const id of removeDeps.filter((dep) => !current.includes(dep))) {
    notices.push(`Dep not present, nothing removed: ${id}`);
  }
  const dep = [...new Set([...current, ...addDeps])].filter((id) => !removeDeps.includes(id));
  if (!sameIds(dep, current)) changes.dep = dep;
  return { changes, notices };
}

export function patchChange(task: Task, edit: PatchEdit): TaskChange {
  const current = task.tags ?? [];
  const { changes, notices } = edgeChange(task, edit);
  const { append, addTag, removeTag } = edit;
  if (append !== undefined) changes.notes = appendLine(task.notes, append);
  if (addTag !== undefined) {
    if (current.includes(addTag)) notices.push(`Tag already present, nothing added: ${addTag}`);
    else changes.tags = [...current, addTag];
  }
  if (removeTag !== undefined) {
    if (current.includes(removeTag)) {
      changes.tags = (changes.tags ?? current).filter((tag) => tag !== removeTag);
    } else {
      notices.push(`Tag not present, nothing removed: ${removeTag}`);
    }
  }
  return { changes, notices };
}

function guardFieldEdit(task: Task, field: EditableField, value: unknown): void {
  if (field === 'notes' && typeof value === 'string') {
    const current = task.notes ?? '';
    if (value.length < current.length) {
      throw new UsageError(
        `Refusing to shrink notes (${current.length} -> ${value.length} chars). ` +
          'Use --append to add a line, or pass --force to replace the notes',
      );
    }
  }
  if (field === 'tags' && Array.isArray(value)) {
    const dropped = (task.tags ?? []).filter((tag) => !value.includes(tag));
    if (dropped.length > 0) {
      throw new UsageError(
        `Refusing to drop existing tags: ${dropped.join(', ')}. ` +
          'Use --add-tag or --remove-tag to change one tag, or pass --force to replace the tags',
      );
    }
  }
  if (field === 'done_when' && (task.done_when ?? '').trim() !== '') {
    throw new UsageError('Refusing to replace a non-empty done_when. Pass --force to replace it');
  }
}

// The status set moves to the category registry; until that lands, keep the set tasks have always had.
function assertBuiltInStatus(value: unknown): void {
  const allowed = BUILT_IN_STATUSES.map((status) => status.id);
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ValidationError(
      `Invalid value for status: ${String(value)} (allowed: ${allowed.join(', ')})`,
    );
  }
}

function changeFor(task: Task, edit: Edit, date: string, force: boolean): TaskChange {
  if (edit.kind === 'patch') return patchChange(task, edit);
  const value = coerceValue(edit.field, edit.value);
  if (edit.field === 'status') assertBuiltInStatus(value);
  if (!force) guardFieldEdit(task, edit.field, value);
  const changes: Record<string, unknown> = { [edit.field]: value };
  if (edit.field === 'status' && edit.value === 'done') changes.done_at = date;
  return { changes, notices: [] };
}

async function loadTask(file: string, id: string): Promise<Task> {
  try {
    return await readYaml(file, TaskSchema);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NotFoundError(`Task not found: ${id}`);
    }
    throw err;
  }
}

function edgeParts(task: Task, edit: PatchEdit): string[] {
  const current = readEdges(task).dep;
  const parts: string[] = [];
  if (edit.parent !== undefined && edit.parent !== task.parent) parts.push(`parent ${edit.parent}`);
  for (const id of edit.addDeps ?? []) if (!current.includes(id)) parts.push(`+dep ${id}`);
  for (const id of edit.removeDeps ?? []) if (current.includes(id)) parts.push(`-dep ${id}`);
  return parts;
}

/** Names what the edit changed: the field, "notes", "+tag x", "-tag x", "parent x", "+dep x" or "-dep x". */
function editedLine(task: Task, edit: Edit): string {
  if (edit.kind === 'field') return `${task.id} edited: ${edit.field}`;
  const tags = task.tags ?? [];
  const parts: string[] = [];
  if (edit.append !== undefined) parts.push('notes');
  if (edit.addTag !== undefined && !tags.includes(edit.addTag)) parts.push(`+tag ${edit.addTag}`);
  if (edit.removeTag !== undefined && tags.includes(edit.removeTag)) {
    parts.push(`-tag ${edit.removeTag}`);
  }
  parts.push(...edgeParts(task, edit));
  return parts.length === 0 ? `${task.id} unchanged` : `${task.id} edited: ${parts.join(', ')}`;
}

function announce(ctx: CommandContext, notices: string[]): void {
  ctx.warnings.push(...notices);
  if (ctx.format === 'json') return;
  for (const notice of notices) process.stderr.write(`${notice}\n`);
}

export default defineCommand<Args, TaskOrLine>({
  name: 'task.edit',
  description:
    'Edit a single field on a task, append a note line, add/remove one tag, or set parent and deps',
  args: ArgsSchema,
  result: TaskOrLineSchema,
  cli: {
    positional: ['slug', 'id', 'field', 'value'],
    options: {
      append: { long: '--append', description: 'Append one line to notes, keeping the rest' },
      add_tag: { long: '--add-tag', description: 'Add one tag, keeping the others' },
      remove_tag: { long: '--remove-tag', description: 'Remove one tag, keeping the others' },
      parent: { long: '--parent', description: 'Set the parent task id, in this initiative' },
      dep: { long: '--dep', description: 'Comma-separated ids to add as deps (any initiative)' },
      remove_dep: { long: '--remove-dep', description: 'Comma-separated ids to drop from deps' },
      force: {
        long: '--force',
        description: 'Let the field form shrink notes, drop tags or replace a non-empty done_when',
      },
      quiet: quietOption('PRJ-12 edited: notes'),
    },
  },
  async run(args, ctx) {
    const edit = parseEdit(args);
    getActiveRoot();
    return withFileLock(getLockPath(args.slug), async () => {
      const file = path.join(getInitiativeDir(args.slug), 'tasks', `${args.id}.yml`);
      const task = await loadTask(file, args.id);
      const date = today();
      const { changes, notices } = changeFor(task, edit, date, args.force === true);
      announce(ctx, notices);
      const line = (): string => editedLine(task, edit);
      if (Object.keys(changes).length === 0) return quietOr(args.quiet, ctx, task, line);
      if (changes.parent !== undefined || changes.dep !== undefined) {
        await assertEdgeWrite({
          slug: args.slug,
          id: task.id,
          parent: changes.parent,
          dep: changes.dep,
        });
      }
      const parsed = TaskSchema.safeParse({ ...task, ...changes, updated: date });
      if (!parsed.success) {
        const target = args.field ?? Object.keys(changes).join(', ');
        throw new ValidationError(`Invalid value for ${target}: ${parsed.error.message}`);
      }
      await writeYaml(file, parsed.data, TaskSchema);
      return quietOr(args.quiet, ctx, parsed.data, line);
    });
  },
});
