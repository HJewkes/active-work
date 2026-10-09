import { DELIVERABLE_STATUSES } from '@titan-design/pm';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import {
  DeliverableTaskCountsSchema,
  joinedTasks,
  loadDeliverables,
  type Deliverable,
} from './_deliverables.js';

const ArgsSchema = z.object({
  tag: z.array(z.string().min(1)).optional(),
  status: z.enum(DELIVERABLE_STATUSES).optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const RowSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(DELIVERABLE_STATUSES),
  target: z.string().nullable(),
  owner_seat: z.string(),
  tags: z.array(z.string()),
  tasks: DeliverableTaskCountsSchema,
});

type Row = z.infer<typeof RowSchema>;

// Tags only narrow what is shown; dispatch reads status and the dep graph, never a tag.
function matches(deliverable: Deliverable, args: Args): boolean {
  if (args.status !== undefined && deliverable.status !== args.status) return false;
  return (args.tag ?? []).every((tag) => deliverable.tags.includes(tag));
}

export default defineCommand<Args, Row[]>({
  name: 'deliverable.list',
  description: 'List deliverables with open and done counts of their tasks across all initiatives',
  args: ArgsSchema,
  result: z.array(RowSchema),
  cli: {
    options: {
      tag: { long: '--tag', description: 'Only deliverables with this tag; repeat to AND tags' },
      status: { long: '--status', description: 'planned|active|shipped|dropped' },
    },
  },
  async run(args, ctx) {
    const shown = (await loadDeliverables(ctx.activeRoot)).filter((d) => matches(d, args));
    if (shown.length === 0) return [];
    const joined = await joinedTasks(ctx.activeRoot);
    return shown.map(({ id, title, status, target, owner_seat, tags }) => {
      const tasks = joined.get(id);
      const counts = { open: tasks?.open.length ?? 0, done: tasks?.done.length ?? 0 };
      return { id, title, status, target, owner_seat, tags, tasks: counts };
    });
  },
});
