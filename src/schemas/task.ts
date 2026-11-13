import { TaskSchema as PmTaskSchema } from '@titan-design/pm';
import type { z } from 'zod';

/**
 * Tasks written before CC-917 carry DATE-only `created` and `done_at`; newer ones carry a full
 * ISO-8601 timestamp so throughput keeps the time of day. pm's schema accepts both forms and
 * `started_at` itself, so old files keep parsing and are never rewritten.
 */
export const TaskSchema = PmTaskSchema;

export type Task = z.infer<typeof TaskSchema>;
