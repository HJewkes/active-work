import { z } from 'zod';
import { listFacets } from '../facets/facet-file.js';
import { defineCommand } from '../registry/index.js';
import { listInitiativeSlugs } from './_open-helpers.js';

const ArgsSchema = z.object({
  slug: z.string().min(1).optional(),
});

const FacetEntrySchema = z.object({
  alias: z.string(),
  owner: z.string(),
  tags: z.array(z.string()),
  about: z.string().optional(),
  path: z.string(),
  // An initiative directory with the same name wins resolution, so `aw <alias>` never reaches it.
  shadowed: z.boolean(),
});

const ResultSchema = z.object({
  facets: z.array(FacetEntrySchema),
  errors: z.array(z.object({ path: z.string(), error: z.string() })),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'facet.list',
  description:
    'List facet aliases (all initiatives, or one), with their tags and whether an initiative of the same name shadows them.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {},
    usage: 'active-work facet list [slug]',
  },
  async run(args, ctx) {
    const slugs = await listInitiativeSlugs(ctx.activeRoot);
    const owners = args.slug ? slugs.filter((s) => s === args.slug) : slugs;
    const { facets, malformed } = await listFacets(ctx.activeRoot, owners);
    return {
      facets: facets.map((facet) => ({
        alias: facet.name,
        owner: facet.owner,
        tags: facet.tags,
        ...(facet.about !== undefined ? { about: facet.about } : {}),
        path: facet.path,
        shadowed: slugs.includes(facet.name),
      })),
      errors: malformed,
    };
  },
});
