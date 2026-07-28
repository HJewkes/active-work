import { z } from 'zod';

// Accepts standard ISO 8601 datetimes with timezone (Z or ±HH:MM), optional fractional seconds.
const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isValidIso8601 = (value: string): boolean => {
  if (!ISO_8601_REGEX.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
};

const iso8601 = z
  .string()
  .refine(isValidIso8601, { message: 'Must be a valid ISO 8601 datetime with timezone' });

/**
 * A loop this session opened. `id` is unique within the session; the global
 * reference used by `resolves` is `<session file stem>#<id>` — the filename,
 * not `session_id`, because one session can record several files.
 */
export const NextStepSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  kind: z.enum(['task', 'pr', 'prose']),
  ref: z.string().min(1).optional(),
});

/** A loop opened by a prior session that this session closed. */
export const SessionResolveSchema = z.object({
  ref: z.string().regex(/^[^#\s]+#[^#\s]+$/, {
    message: "ref must be '<session file stem>#<next_step id>'",
  }),
  outcome: z.enum(['done', 'abandoned']),
  note: z.string().min(1).optional(),
});

type NextStepInput = z.infer<typeof NextStepSchema>;
type ResolveInput = z.infer<typeof SessionResolveSchema>;

function checkUniqueStepIds(steps: NextStepInput[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    if (seen.has(step.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['next_steps', index, 'id'],
        message: `next_steps ids must be unique within a session: ${step.id}`,
      });
    }
    seen.add(step.id);
  });
}

function checkAbandonedHasNote(entries: ResolveInput[], ctx: z.RefinementCtx): void {
  entries.forEach((entry, index) => {
    if (entry.outcome === 'abandoned' && entry.note === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['resolves', index, 'note'],
        message: 'note is required when outcome is "abandoned"',
      });
    }
  });
}

export const SessionFrontmatterSchema = z
  .object({
    session_id: z.string().min(1),
    started: iso8601,
    ended: iso8601,
    track: z.enum(['canonical', 'sidecar', 'adhoc']),
    next_steps: z.array(NextStepSchema).default([]),
    resolves: z.array(SessionResolveSchema).default([]),
  })
  .superRefine((value, ctx) => {
    const started = new Date(value.started).getTime();
    const ended = new Date(value.ended).getTime();
    if (Number.isFinite(started) && Number.isFinite(ended) && ended < started) {
      ctx.addIssue({
        code: 'custom',
        path: ['ended'],
        message: 'ended must be greater than or equal to started',
      });
    }
    checkUniqueStepIds(value.next_steps, ctx);
    checkAbandonedHasNote(value.resolves, ctx);
  });

export type NextStep = z.infer<typeof NextStepSchema>;
export type SessionResolve = z.infer<typeof SessionResolveSchema>;
export type SessionFrontmatter = z.infer<typeof SessionFrontmatterSchema>;
