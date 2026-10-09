import { promises as fs } from 'node:fs';
import YAML from 'yaml';
import {
  CategoryRegistrySchema,
  categoriesPath,
  type CategoryRegistry,
  type StatusEntry,
} from '@titan-design/pm';
import { z } from 'zod';
import { defineCommand, type CommandContext } from '../registry/index.js';
import { UsageError, ValidationError } from '../errors.js';
import { loadEdgeIndex } from '../tasks/edge-index.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { writeYaml } from '../utils/yaml-io.js';
import { loadCategoryRegistry, warn } from './_categories.js';

const CATEGORY_ID = /^[a-z0-9][a-z0-9-]*$/;

// icebox is parked, not closed: it never dispatches but is still live work.
const SEED_STATUSES: StatusEntry[] = [
  { id: 'open', closed: false, dispatchable: true },
  { id: 'done', closed: true, dispatchable: false },
  { id: 'wont-do', closed: true, dispatchable: false },
  { id: 'icebox', closed: false, dispatchable: false },
];

const ArgsSchema = z.object({
  areas: z.string().min(1).optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  path: z.string(),
  created: z.boolean(),
  registry: CategoryRegistrySchema,
});

type Result = z.infer<typeof ResultSchema>;

interface Observed {
  values: string[];
  skipped: string[];
}

function observedTagValues(tags: readonly string[], prefix: string, seed: string[]): Observed {
  const values = new Set(seed);
  const skipped = new Set<string>();
  for (const tag of tags.filter((t) => t.startsWith(prefix))) {
    const value = tag.slice(prefix.length);
    if (CATEGORY_ID.test(value)) values.add(value);
    else skipped.add(tag);
  }
  return { values: [...values].sort(), skipped: [...skipped].sort() };
}

// Accepts the output of titan-platform scripts/areas.mjs (an `area:` section) or a bare list.
async function readAreas(file: string | undefined): Promise<unknown[]> {
  if (file === undefined) return [];
  const parsed: unknown = YAML.parse(await fs.readFile(file, 'utf8'));
  const areas = Array.isArray(parsed) ? parsed : (parsed as { area?: unknown } | null)?.area;
  if (!Array.isArray(areas)) throw new UsageError(`${file} holds no area list`);
  return areas;
}

function buildRegistry(kind: string[], cos: string[], area: unknown[]): CategoryRegistry {
  const parsed = CategoryRegistrySchema.safeParse({ kind, status: SEED_STATUSES, cos, area });
  if (!parsed.success) {
    throw new ValidationError(`The seeded registry is not valid: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function seed(args: Args, ctx: CommandContext): Promise<CategoryRegistry> {
  const tags = (await loadEdgeIndex()).entries.flatMap(({ task }) => task.tags ?? []);
  const kind = observedTagValues(tags, 'kind:', ['epic']);
  const cos = observedTagValues(tags, 'cos:', []);
  const skipped = [...kind.skipped, ...cos.skipped];
  if (skipped.length > 0)
    warn(ctx, `Skipped tags that are not category ids: ${skipped.join(', ')}`);
  if (args.areas === undefined) {
    warn(
      ctx,
      'No --areas file: area is empty. Fill it with titan-platform scripts/areas.mjs --write',
    );
  }
  return buildRegistry(kind.values, cos.values, await readAreas(args.areas));
}

export default defineCommand<Args, Result>({
  name: 'category.init',
  description:
    'Seed titan-platform/categories.yml once, from the kind: and cos: tags in use and an area list',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      areas: {
        long: '--areas',
        description: 'YAML file with the area section (output of titan-platform scripts/areas.mjs)',
      },
    },
  },
  async run(args, ctx) {
    const file = categoriesPath(ctx.activeRoot);
    return withFileLock(file, async () => {
      const existing = await loadCategoryRegistry(ctx.activeRoot);
      if (existing !== null) {
        warn(ctx, `${file} already exists; left unchanged`);
        return { path: file, created: false, registry: existing };
      }
      const registry = await seed(args, ctx);
      await writeYaml(file, registry, CategoryRegistrySchema);
      return { path: file, created: true, registry };
    });
  },
});
