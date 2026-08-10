import { z } from 'zod';

// Accepts standard ISO 8601 datetimes with timezone (Z or ±HH:MM), optional fractional seconds.
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isValidIso8601 = (value: string): boolean => {
  if (!ISO_8601_REGEX.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
};

const iso8601 = z
  .string()
  .refine(isValidIso8601, { message: 'Must be a valid ISO 8601 datetime with timezone' });

// A loop is closed by a `resolves` entry matching `<session file stem>#<id>`.
// Both halves of that reference must therefore avoid `#` (the separator) and
// whitespace; `session_id` must also avoid `/`, since it becomes part of the
// filename. Without this, a loop filed as `step 1` can never be resolved.
const REF_SEGMENT_REGEX = /^[^#\s/]+$/;
const REF_SEGMENT_MESSAGE = 'must not contain whitespace, "#" or "/"';

/** `session_id`; also the tail of every session filename. */
export const SessionIdSchema = z
  .string()
  .min(1)
  .regex(REF_SEGMENT_REGEX, { message: `session_id ${REF_SEGMENT_MESSAGE}` });

/**
 * A loop this session opened. `id` is unique within the session; the global
 * reference used by `resolves` is `<session file stem>#<id>` — the filename,
 * not `session_id`, because one session can record several files.
 */
export const NextStepSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(REF_SEGMENT_REGEX, { message: `next_steps id ${REF_SEGMENT_MESSAGE}` }),
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
    session_id: SessionIdSchema,
    started: iso8601,
    ended: iso8601,
    track: z.enum(['canonical', 'sidecar', 'adhoc']),
    next_steps: z.array(NextStepSchema).default([]),
    resolves: z.array(SessionResolveSchema).default([]),
    // Written only by `wrap --no-loops`. An empty ledger alone cannot say
    // whether nothing was hanging or nothing was filed; this marker does.
    no_loops: z.literal(true).optional(),
    // The session that spawned this one (AW-26). Set for agent-chat peers,
    // whose parentage is known only to the spawning hook — a peer runs as its
    // own `claude` process, so nothing in its transcript records who asked for
    // it. Built-in subagents are linked in the miner index instead, where the
    // relationship *is* derivable from the transcript tree.
    parent_session_id: SessionIdSchema.optional(),
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
    if (value.no_loops === true && (value.next_steps.length > 0 || value.resolves.length > 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['no_loops'],
        message: 'no_loops cannot be set alongside next_steps or resolves',
      });
    }
  });

export type NextStep = z.infer<typeof NextStepSchema>;
export type SessionResolve = z.infer<typeof SessionResolveSchema>;
export type SessionFrontmatter = z.infer<typeof SessionFrontmatterSchema>;
