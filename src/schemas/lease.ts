import { z } from 'zod';

// Accepts standard ISO 8601 datetimes with timezone (Z or ±HH:MM), optional
// fractional seconds. Mirrors `src/schemas/session.ts`, deliberately duplicated
// rather than shared: the session schema's refinements are about the loop
// ledger, and a lease has no business inheriting them.
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isValidIso8601 = (value: string): boolean => {
  if (!ISO_8601_REGEX.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
};

const iso8601 = z
  .string()
  .refine(isValidIso8601, { message: 'Must be a valid ISO 8601 datetime with timezone' });

/**
 * How the lease was written, which is also how much its liveness can be
 * trusted.
 *
 * `launcher` — written by `aw`, whose own process lifetime brackets the Claude
 * session it spawned. `pid` is that process, so liveness is a *fact*.
 *
 * `oneshot` — written by `open` on the MCP / bare-CLI path, where the writing
 * process exits as soon as it has produced the prompt. There is nothing to
 * signal, so liveness is a TTL *guess* and must be rendered as one.
 */
export const LeaseModeSchema = z.enum(['launcher', 'oneshot']);

export const LeaseSchema = z.object({
  /** Random hex; also the filename stem (`<lease_id>.json`). */
  lease_id: z.string().min(1),
  slug: z.string().min(1),
  /** The launch cwd, so a sibling can be told apart from a second checkout. */
  cwd: z.string().min(1),
  mode: LeaseModeSchema,
  /** Present only for `launcher` leases — the `aw` process to probe. */
  pid: z.number().int().positive().optional(),
  started: iso8601,
  /** Human/role hint carried for future use (e.g. an agent-chat name). */
  label: z.string().min(1).optional(),
});

export type LeaseMode = z.infer<typeof LeaseModeSchema>;
export type Lease = z.infer<typeof LeaseSchema>;
