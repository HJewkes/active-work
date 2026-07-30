import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { getActiveRoot, getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { today } from '../utils/today.js';
import { NotFoundError, UsageError, ValidationError } from '../errors.js';

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
  field: z.string().min(1),
  value: z.unknown(),
});

type Args = z.infer<typeof ArgsSchema>;

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

export default defineCommand<Args, Task>({
  name: 'task.edit',
  description: 'Edit a single field on a task',
  args: ArgsSchema,
  result: TaskSchema,
  cli: {
    positional: ['slug', 'id', 'field', 'value'],
  },
  async run(args) {
    const { field } = args;
    if (!isEditable(field)) {
      throw new UsageError(
        `Field is not editable: ${field} (allowed: ${EDITABLE_FIELDS.join(', ')})`,
      );
    }
    getActiveRoot();
    return withFileLock(getLockPath(args.slug), async () => {
      const file = path.join(getInitiativeDir(args.slug), 'tasks', `${args.id}.yml`);
      let task: Task;
      try {
        task = await readYaml(file, TaskSchema);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new NotFoundError(`Task not found: ${args.id}`);
        }
        throw err;
      }
      const date = today();
      const next: Record<string, unknown> = {
        ...task,
        [field]: coerceValue(field, args.value),
      };
      next.updated = date;
      if (args.field === 'status' && args.value === 'done') {
        next.done_at = date;
      }
      const parsed = TaskSchema.safeParse(next);
      if (!parsed.success) {
        throw new ValidationError(`Invalid value for ${args.field}: ${parsed.error.message}`);
      }
      await writeYaml(file, parsed.data, TaskSchema);
      return parsed.data;
    });
  },
});
