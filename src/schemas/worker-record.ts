import { z } from 'zod';
import { WorkerFactsSchema } from '@titan-design/agent-protocol/worker-facts';

/**
 * The `worker` block of a session record (TP-1709), and the JSON `wrap --facts`
 * accepts. `facts` is what agent-chat's broker observed about a spawned worker
 * and is validated by the shared schema, never a copy of it. The rest is what
 * the recorder derived from the report (`resolves`, `outcome`, `last_action`)
 * plus an optional, size-capped `authored` block.
 */

export const MAX_AUTHORED_LENGTH = 1500;
export const NO_REPORT_OUTCOME = 'exited-no-report';

const TaskIdSchema = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/, {
  message: 'must be a task id such as AW-12',
});

const AuthoredSchema = z
  .strictObject({
    continuations: z.array(z.string().min(1)).optional(),
    open_questions: z.array(z.string().min(1)).optional(),
    next_why: z.string().min(1).optional(),
  })
  .refine((value) => JSON.stringify(value).length <= MAX_AUTHORED_LENGTH, {
    message: `authored must serialize to at most ${MAX_AUTHORED_LENGTH} characters`,
  });

export const WorkerRecordSchema = z
  .strictObject({
    facts: WorkerFactsSchema,
    /** Task ids the report names as closed, done or merged. */
    resolves: z.array(TaskIdSchema).optional(),
    outcome: z.literal(NO_REPORT_OUTCOME).optional(),
    /** The exit report's last action, for a worker that sent no report. */
    last_action: z.string().min(1).optional(),
    authored: AuthoredSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasReport = value.facts.report != null;
    if (hasReport && value.outcome !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: `outcome ${NO_REPORT_OUTCOME} contradicts a facts.report`,
      });
    }
    if (!hasReport && value.outcome === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: `a worker with no facts.report must carry outcome ${NO_REPORT_OUTCOME}`,
      });
    }
  });

export type WorkerRecord = z.infer<typeof WorkerRecordSchema>;
