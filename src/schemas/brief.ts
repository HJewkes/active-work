import { z } from 'zod';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const isValidIsoDate = (value: string): boolean => {
  if (!ISO_DATE_REGEX.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  // Reject dates like 2026-02-30 that JS happily rolls forward.
  return parsed.toISOString().slice(0, 10) === value;
};

const isoDate = z
  .string()
  .refine(isValidIsoDate, { message: 'Must be a valid zero-padded YYYY-MM-DD date' });

const positiveInt = z.number().int().positive();

const worktreeEntry = z.object({
  path: z.string().min(1),
  default: z.boolean().optional(),
});

export const BriefFrontmatterSchema = z
  .object({
    schema_version: positiveInt,
    title: z.string().min(1),
    updated: isoDate,
    state: z.enum(['focused', 'backburner', 'paused', 'done']),
    rank: positiveInt.optional(),
    paused_since: isoDate.optional(),
    restart_trigger: z.string().min(1).optional(),
    ship_target: z.string().optional(),
    owner: z.string().optional(),
    task_prefix: z
      .string()
      .min(1)
      .regex(/^[A-Z][A-Z0-9]*$/, {
        message: 'task_prefix must be uppercase letters/digits starting with a letter',
      }),
    worktrees: z.record(z.string(), worktreeEntry).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.state === 'focused' && value.rank === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['rank'],
        message: 'rank is required when state is "focused"',
      });
    }
    if (value.state === 'paused') {
      if (value.paused_since === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['paused_since'],
          message: 'paused_since is required when state is "paused"',
        });
      }
      if (value.restart_trigger === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['restart_trigger'],
          message: 'restart_trigger is required when state is "paused"',
        });
      }
    }
  });

export type BriefFrontmatter = z.infer<typeof BriefFrontmatterSchema>;
