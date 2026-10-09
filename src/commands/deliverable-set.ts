import { DELIVERABLE_STATUSES } from '@titan-design/pm';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { UsageError } from '../errors.js';
import { today } from '../utils/today.js';
import {
  DeliverableSchema,
  loadDeliverable,
  withDeliverablesLock,
  writeDeliverable,
  type Deliverable,
} from './_deliverables.js';

const ArgsSchema = z.object({
  id: z.string().min(1),
  // Shipping checks the joined tasks, so it has its own verb.
  status: z.enum(DELIVERABLE_STATUSES).exclude(['shipped']).optional(),
  target: z.string().optional(),
  owner_seat: z.string().min(1).optional(),
});

type Args = z.infer<typeof ArgsSchema>;

/** `--target none` clears the date. Leaving shipped clears shipped_at, which only a shipped record holds. */
function changesFor(args: Args): Partial<Deliverable> {
  const changes: Partial<Deliverable> = {};
  if (args.status !== undefined) {
    changes.status = args.status;
    changes.shipped_at = null;
  }
  if (args.target !== undefined) changes.target = args.target === 'none' ? null : args.target;
  if (args.owner_seat !== undefined) changes.owner_seat = args.owner_seat;
  return changes;
}

export default defineCommand<Args, Deliverable>({
  name: 'deliverable.set',
  description: 'Set the status, target or owner seat of one deliverable',
  args: ArgsSchema,
  result: DeliverableSchema,
  cli: {
    positional: ['id'],
    options: {
      status: {
        long: '--status',
        description: 'planned|active|dropped (ship with deliverable ship)',
      },
      target: { long: '--target', description: 'Target date, YYYY-MM-DD, or none to clear it' },
      owner_seat: { long: '--owner-seat', description: 'Seat that owns it' },
    },
  },
  async run(args, ctx) {
    const changes = changesFor(args);
    if (Object.keys(changes).length === 0) {
      throw new UsageError('Nothing to set: pass --status, --target or --owner-seat');
    }
    return withDeliverablesLock(ctx.activeRoot, async () => {
      const current = await loadDeliverable(ctx.activeRoot, args.id);
      const next = { ...current, ...changes, updated: today() };
      await writeDeliverable(ctx.activeRoot, next);
      return next;
    });
  },
});
