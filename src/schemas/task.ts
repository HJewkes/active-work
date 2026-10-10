import { TaskSchema as PmTaskSchema } from '@titan-design/pm';
import { z } from 'zod';

const isoTimestamp = z.iso.datetime({ offset: true });

/**
 * Tasks written before CC-917 carry DATE-only `created` and `done_at`; newer ones carry a full
 * ISO-8601 UTC timestamp so throughput keeps the time of day. Both must keep parsing, and old
 * files are never rewritten.
 */
const isoDateOrTimestamp = z.union([PmTaskSchema.shape.created, isoTimestamp]);

export const TaskSchema = PmTaskSchema.extend({
  created: isoDateOrTimestamp,
  done_at: z.union([isoDateOrTimestamp, z.null()]),
  started_at: isoTimestamp.optional(),
});

export type Task = z.infer<typeof TaskSchema>;
