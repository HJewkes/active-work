import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getFacetPath, writeFacetFile } from '../facets/facet-file.js';
import { validateSlug } from '../utils/slug.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { defineCommand } from '../registry/index.js';
import { listInitiativeSlugs } from './_open-helpers.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  alias: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  about: z.string().min(1).optional(),
});

const ResultSchema = z.object({
  path: z.string(),
  alias: z.string(),
  owner: z.string(),
  tags: z.array(z.string()),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

const PLACEHOLDER_BODY =
  'Describe this facet: what the sub-area covers and where its work lives.\n';

async function assertAddable(activeRoot: string, args: Args, facetPath: string): Promise<void> {
  const aliasCheck = validateSlug(args.alias);
  if (!aliasCheck.ok) throw new ValidationError(`Invalid facet alias: ${aliasCheck.error}`);
  const slugs = await listInitiativeSlugs(activeRoot);
  if (!slugs.includes(args.slug)) throw new NotFoundError(`Initiative not found: ${args.slug}`);
  if (slugs.includes(args.alias)) {
    throw new ValidationError(
      `Facet alias '${args.alias}' equals an initiative slug and would be shadowed by it`,
    );
  }
  const exists = await fs.access(facetPath).then(
    () => true,
    () => false,
  );
  if (exists) throw new ValidationError(`Facet already exists: ${facetPath}`);
}

export default defineCommand<Args, Result>({
  name: 'facet.add',
  description:
    "Add a facet alias to an initiative: `aw <alias>` then opens the initiative with the facet's body, its `about` as the retrieval subject, and tasks and loops filtered to its tags.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug', 'alias'],
    options: {
      tags: { long: '--tags', description: 'Comma-separated task tags', required: true },
      about: { long: '--about', description: 'What the facet is about (ranks notes and loops)' },
    },
    usage: 'active-work facet add <slug> <alias> --tags a,b [--about <text>]',
  },
  async run(args, ctx) {
    const facetPath = getFacetPath(ctx.activeRoot, args.slug, args.alias);
    const frontmatter = {
      tags: args.tags,
      ...(args.about !== undefined ? { about: args.about } : {}),
    };
    return withFileLock(path.join(ctx.activeRoot, args.slug, '.lock'), async () => {
      await assertAddable(ctx.activeRoot, args, facetPath);
      await writeFacetFile(facetPath, frontmatter, PLACEHOLDER_BODY);
      return { path: facetPath, alias: args.alias, owner: args.slug, tags: args.tags };
    });
  },
});
