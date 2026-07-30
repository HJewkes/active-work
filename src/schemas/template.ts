import { z } from 'zod';

/**
 * AW-28: Drain-clustered tool-result / error templates.
 *
 * `Locator` is `[transcriptIndex, byteOffset, byteLength]` — a pointer back
 * into the source `.jsonl` transcript, never the blob text itself. Full
 * text is never copied into templates.yml or occurrences.jsonl (see
 * sources/deepdive-session-mining-build-specs.md §C1).
 */
export const LocatorSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().positive(),
]);

export const TemplateSchema = z.object({
  templateId: z.string().min(1),
  toolType: z.string().min(1),
  maskedSignature: z.string().min(1),
  createdAt: z.string().min(1),
  occurrenceCount: z.number().int().nonnegative(),
  exemplarLocator: LocatorSchema,
});

export const OccurrenceSchema = z.object({
  templateId: z.string().min(1),
  locator: LocatorSchema,
  sessionId: z.string().min(1),
  timestamp: z.string().min(1),
  extractedParams: z.record(z.string(), z.string()).optional(),
});

export const TemplatesFileSchema = z.object({
  templates: z.array(TemplateSchema).default([]),
});

export type Locator = z.infer<typeof LocatorSchema>;
export type Template = z.infer<typeof TemplateSchema>;
export type Occurrence = z.infer<typeof OccurrenceSchema>;
export type TemplatesFile = z.infer<typeof TemplatesFileSchema>;
