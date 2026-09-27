import { z } from 'zod';

/**
 * One precedent: a question the human answered, or a note recording how they
 * want something done. The decider cites these rows verbatim, so every row
 * carries enough to find its origin again (`key`).
 */

export const PRECEDENT_SOURCES = ['transcript', 'note', 'queue'] as const;

export const PICK_TYPES = [
  'recommended',
  'other_option',
  'free_text',
  'rejected',
  'unparsed',
  'none',
] as const;

export const PrecedentRowSchema = z.object({
  /** Idempotency key: `transcript:<session>:<tool_use_id>`, `note:<slug>/<file>`, `queue:<event id>`. */
  key: z.string().min(1),
  source: z.enum(PRECEDENT_SOURCES),
  asked_at: z.string().nullable(),
  session_id: z.string().nullable(),
  tool_use_id: z.string().nullable(),
  initiative: z.string().nullable(),
  class: z.string(),
  header: z.string().nullable(),
  question: z.string(),
  options: z.array(z.string()),
  recommended: z.string().nullable(),
  answer: z.string().nullable(),
  pick_type: z.enum(PICK_TYPES),
  free_text: z.string().nullable(),
});

export type PrecedentRow = z.infer<typeof PrecedentRowSchema>;
export type PickType = (typeof PICK_TYPES)[number];
