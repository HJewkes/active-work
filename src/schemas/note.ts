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

/**
 * What a note is for. Actionable work becomes a task; these four cover the
 * durable knowledge a session leaves behind that no task would carry:
 * `process` (how to work), `gotcha` (what bit us), `fyi` (context worth
 * keeping), `decision` (what we settled and why).
 */
export const NoteKindSchema = z.enum(['process', 'gotcha', 'fyi', 'decision']);

/**
 * Titles are slugified into filenames, so an unbounded one yields a path no
 * one can read, type, or safely check out on every filesystem.
 *
 * Enforced at write time only. The read path stays permissive so notes filed
 * before the bound existed still load — `doctor` surfaces those instead of the
 * loader dropping captured knowledge on the floor.
 */
export const NOTE_TITLE_MAX_LENGTH = 120;

export const NoteFrontmatterSchema = z.object({
  kind: NoteKindSchema,
  title: z.string().min(1),
  created: isoDate,
  tags: z.array(z.string().min(1)).optional(),
});

export type NoteKind = z.infer<typeof NoteKindSchema>;
export type NoteFrontmatter = z.infer<typeof NoteFrontmatterSchema>;
