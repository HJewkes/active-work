import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { ValidationError } from '../errors.js';
import { today } from '../utils/today.js';
import {
  DeliverableSchema,
  joinedTasks,
  loadDeliverable,
  withDeliverablesLock,
  writeDeliverable,
  type Deliverable,
} from './_deliverables.js';

const ArgsSchema = z.object({
  id: z.string().min(1),
  force: z.boolean().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

async function assertNoOpenTasks(activeRoot: string, id: string): Promise<void> {
  const open = (await joinedTasks(activeRoot)).get(id)?.open ?? [];
  if (open.length === 0) return;
  const ids = open.map((task) => task.id).join(', ');
  throw new ValidationError(
    `Refusing to ship ${id}: ${open.length} joined task(s) still open: ${ids}. ` +
      'Close them, or pass --force to ship anyway',
  );
}

export default defineCommand<Args, Deliverable>({
  name: 'deliverable.ship',
  description: 'Mark a deliverable shipped; refuses while a joined task is open unless --force',
  args: ArgsSchema,
  result: DeliverableSchema,
  cli: {
    positional: ['id'],
    options: {
      force: { long: '--force', description: 'Ship even though joined tasks are still open' },
    },
  },
  async run(args, ctx) {
    return withDeliverablesLock(ctx.activeRoot, async () => {
      const current = await loadDeliverable(ctx.activeRoot, args.id);
      if (current.status === 'shipped') return current;
      if (args.force !== true) await assertNoOpenTasks(ctx.activeRoot, args.id);
      const date = today();
      const next: Deliverable = { ...current, status: 'shipped', shipped_at: date, updated: date };
      await writeDeliverable(ctx.activeRoot, next);
      return next;
    });
  },
});
