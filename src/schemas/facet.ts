import { z } from 'zod';

/**
 * Frontmatter of `<initiative>/facets/<alias>.md` (TP-326). The alias is the
 * filename; the body is free markdown rendered under the facet heading.
 */
export const FacetFrontmatterSchema = z.object({
  tags: z.array(z.string().min(1)).min(1),
  about: z.string().min(1).optional(),
});

export type FacetFrontmatter = z.infer<typeof FacetFrontmatterSchema>;
