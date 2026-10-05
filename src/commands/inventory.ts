import { z } from 'zod';
import { listInitiativeSlugs } from '../lint/index.js';
import { getActiveRoot } from '../utils/paths.js';
import { scanInventory } from '../workspace-index/inventory.js';
import { summarizeInventory, totalInventory } from '../workspace-index/inventory-summary.js';
import { WIRE_CLASSES, type WireClass } from '../workspace-index/wire.js';
import { defineCommand } from '../registry/index.js';
import { humanOnlyPredicate } from './_list-scope.js';

const ArgsSchema = z.object({}).strict();

const StatSchema = z.object({
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  newest_mtime: z.string().nullable(),
});

const ClassesSchema = z.object(
  Object.fromEntries(WIRE_CLASSES.map((cls) => [cls, StatSchema])) as Record<
    WireClass,
    typeof StatSchema
  >,
);

const InitiativeSchema = z.object({
  slug: z.string(),
  human_only: z.boolean(),
  total: StatSchema,
  classes: ClassesSchema,
  nested_dirs: z.array(StatSchema.extend({ dir: z.string() })),
});

const ResultSchema = z.object({
  initiatives: z.array(InitiativeSchema),
  totals: z.object({ total: StatSchema, classes: ClassesSchema }),
  // False when the charter is unreadable; every initiative is then flagged human_only.
  human_only_known: z.boolean(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'inventory',
  description:
    'What is where under the active root: file count, bytes and newest mtime per initiative and record class, with nested sources (unindexed files under sources/<dir>/) counted separately.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: { usage: 'active-work inventory [--json]' },
  async run(_args, ctx) {
    const activeRoot = getActiveRoot();
    const [slugs, files, humanOnly] = await Promise.all([
      listInitiativeSlugs(activeRoot),
      scanInventory(activeRoot),
      humanOnlyPredicate(activeRoot, ctx.warnings),
    ]);
    const initiatives = summarizeInventory(slugs, files, humanOnly.isHumanOnly);
    return {
      initiatives,
      totals: totalInventory(initiatives),
      human_only_known: humanOnly.known,
    };
  },
});
