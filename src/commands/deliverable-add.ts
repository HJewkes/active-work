import { DELIVERABLE_ID_REGEX, DELIVERABLE_STATUSES } from '@titan-design/pm';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { UsageError } from '../errors.js';
import { today } from '../utils/today.js';
import {
  DeliverableSchema,
  loadDeliverables,
  withDeliverablesLock,
  writeDeliverable,
  type Deliverable,
} from './_deliverables.js';

const ArgsSchema = z.object({
  id: z.string().regex(DELIVERABLE_ID_REGEX, 'id must match /^[A-Za-z][A-Za-z0-9-]*$/'),
  title: z.string().min(1),
  done_when: z.string().min(1),
  owner_seat: z.string().min(1),
  target: z.string().optional(),
  status: z.enum(DELIVERABLE_STATUSES).exclude(['shipped']).optional(),
  tags: z.array(z.string()).optional(),
});

type Args = z.infer<typeof ArgsSchema>;

function newDeliverable(args: Args): Deliverable {
  const date = today();
  return {
    id: args.id,
    title: args.title,
    done_when: args.done_when,
    target: args.target ?? null,
    status: args.status ?? 'planned',
    owner_seat: args.owner_seat,
    tags: args.tags ?? [],
    created: date,
    updated: date,
    shipped_at: null,
  };
}

export default defineCommand<Args, Deliverable>({
  name: 'deliverable.add',
  description: 'Add a deliverable to the platform-wide registry (status defaults to planned)',
  args: ArgsSchema,
  result: DeliverableSchema,
  cli: {
    positional: ['id'],
    options: {
      title: { long: '--title', description: 'Deliverable title', required: true },
      done_when: { long: '--done-when', description: 'Definition of done', required: true },
      owner_seat: { long: '--owner-seat', description: 'Seat that owns it', required: true },
      target: { long: '--target', description: 'Target date, YYYY-MM-DD' },
      status: { long: '--status', description: 'planned|active|dropped (default planned)' },
      tags: { long: '--tags', description: 'Comma-separated retrieval tags' },
    },
  },
  async run(args, ctx) {
    return withDeliverablesLock(ctx.activeRoot, async () => {
      const existing = await loadDeliverables(ctx.activeRoot);
      // Records are named by id, so ids differing only in case would share a file on macOS.
      const clash = existing.find((d) => d.id.toLowerCase() === args.id.toLowerCase());
      if (clash !== undefined) throw new UsageError(`Deliverable already exists: ${clash.id}`);
      const deliverable = newDeliverable(args);
      await writeDeliverable(ctx.activeRoot, deliverable);
      return deliverable;
    });
  },
});
