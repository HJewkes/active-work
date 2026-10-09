import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { getActiveRoot, getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import {
  loadBrief,
  loadExistingTasks,
  maxOnDiskTaskNumber,
  readTaskSeq,
} from '../utils/task-seq.js';
import { writeYaml } from '../utils/yaml-io.js';
import { today } from '../utils/today.js';
import { assertEdgeWrite } from '../tasks/edge-index.js';
import { assertKnownDeliverables } from './_deliverables.js';
import {
  quietOption,
  QuietArg,
  TaskOrLineSchema,
  quietOr,
  type TaskOrLine,
} from './_task-quiet.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  priority: z.number().int().positive().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  estimate: z.number().positive().optional(),
  done_when: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  parent: z.string().min(1).optional(),
  dep: z.array(z.string().min(1)).optional(),
  deliverable: z.array(z.string().min(1)).optional(),
  quiet: QuietArg,
});

type Args = z.infer<typeof ArgsSchema>;

// Ids must never be reissued, even after `task delete` removes the file that
// used the highest number. `task_seq` is the persisted high-water mark for
// that case; it only needs to move when a delete removes the current highest
// id (see task-delete.ts), so `task.add` itself never has to write brief.md
// (AW-94) — it only reads the mark to guard against a stale on-disk scan.
function allocateTaskNumber(
  brief: Awaited<ReturnType<typeof loadBrief>>,
  existing: Task[],
): number {
  const onDisk = maxOnDiskTaskNumber(brief.prefix, existing);
  return Math.max(readTaskSeq(brief, onDisk), onDisk) + 1;
}

function nextPriority(existing: Task[]): number {
  let max = 0;
  for (const t of existing) {
    if (t.priority > max) max = t.priority;
  }
  return max + 1;
}

function newTask(args: Args, id: string, priority: number): Task {
  const date = today();
  return {
    id,
    parent: args.parent,
    dep: args.dep,
    deliverables: args.deliverable && [...new Set(args.deliverable)],
    title: args.title,
    priority,
    severity: args.severity,
    estimate: args.estimate,
    done_when: args.done_when,
    status: 'open',
    tags: args.tags,
    notes: args.notes,
    created: date,
    updated: date,
    done_at: null,
  };
}

export default defineCommand<Args, TaskOrLine>({
  name: 'task.add',
  description: 'Create a new task in an initiative',
  args: ArgsSchema,
  result: TaskOrLineSchema,
  cli: {
    positional: ['slug'],
    options: {
      title: { long: '--title', description: 'Task title', required: true },
      priority: { long: '--priority', description: 'Priority (positive int)' },
      severity: {
        long: '--severity',
        description: 'critical|high|medium|low',
      },
      estimate: { long: '--estimate', description: 'Estimate (hours)' },
      done_when: {
        long: '--done-when',
        description: 'Definition of done',
      },
      tags: { long: '--tags', description: 'Comma-separated tag list' },
      notes: { long: '--notes', description: 'Free-form notes' },
      parent: { long: '--parent', description: 'Parent task id, in this initiative' },
      dep: {
        long: '--dep',
        description: 'Comma-separated ids this task depends on (any initiative)',
      },
      deliverable: {
        long: '--deliverable',
        description: 'Comma-separated deliverable ids this task counts toward',
      },
      quiet: quietOption('PRJ-12 created'),
    },
  },
  async run(args, ctx) {
    // Touch activeRoot so it's resolved before locking.
    const activeRoot = getActiveRoot();
    if (args.deliverable !== undefined) await assertKnownDeliverables(activeRoot, args.deliverable);
    return withFileLock(getLockPath(args.slug), async () => {
      const brief = await loadBrief(args.slug);
      const existing = await loadExistingTasks(args.slug);
      const n = allocateTaskNumber(brief, existing);
      const id = `${brief.prefix}-${n}`;
      if (args.parent !== undefined || args.dep !== undefined) {
        await assertEdgeWrite({ slug: args.slug, id, parent: args.parent, dep: args.dep });
      }
      const task = newTask(args, id, args.priority ?? nextPriority(existing));
      const taskDir = path.join(getInitiativeDir(args.slug), 'tasks');
      await fs.mkdir(taskDir, { recursive: true });
      await writeYaml(path.join(taskDir, `${id}.yml`), task, TaskSchema);
      return quietOr(args.quiet, ctx, task, () => `${id} created`);
    });
  },
});
