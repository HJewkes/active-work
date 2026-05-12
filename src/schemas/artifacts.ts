import { z } from 'zod';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const isValidIsoDate = (value: string): boolean => {
  if (!ISO_DATE_REGEX.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
};

const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isValidIso8601 = (value: string): boolean => {
  if (!ISO_8601_REGEX.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
};

const isoDate = z
  .string()
  .refine(isValidIsoDate, { message: 'Must be a valid zero-padded YYYY-MM-DD date' });

const iso8601 = z
  .string()
  .refine(isValidIso8601, { message: 'Must be a valid ISO 8601 datetime with timezone' });

export const PrEntrySchema = z.object({
  number: z.number().int().positive(),
  repo: z.string().min(1),
  title: z.string(),
  status: z.enum(['open', 'merged', 'closed']),
  last_checked: iso8601,
});

export const BranchEntrySchema = z.object({
  repo: z.string().min(1),
  name: z.string().min(1),
  last_commit: isoDate,
});

export const StashEntrySchema = z.object({
  repo: z.string().min(1),
  message: z.string(),
  created: isoDate,
});

export const ArtifactsSchema = z.object({
  prs: z.array(PrEntrySchema).default([]),
  branches: z.array(BranchEntrySchema).default([]),
  stashes: z.array(StashEntrySchema).default([]),
});

export type PrEntry = z.infer<typeof PrEntrySchema>;
export type BranchEntry = z.infer<typeof BranchEntrySchema>;
export type StashEntry = z.infer<typeof StashEntrySchema>;
export type Artifacts = z.infer<typeof ArtifactsSchema>;
