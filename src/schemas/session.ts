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

export const SessionFrontmatterSchema = z
  .object({
    session_id: z.string().min(1),
    started: iso8601,
    ended: iso8601,
    track: z.enum(['canonical', 'sidecar']),
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
  });

export type SessionFrontmatter = z.infer<typeof SessionFrontmatterSchema>;
