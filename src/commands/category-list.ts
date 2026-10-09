import { categoriesPath, type CategoryAxis, type CategoryRegistry } from '@titan-design/pm';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { loadCategoryRegistry, warn } from './_categories.js';

const AXES = ['kind', 'status', 'cos', 'area'] as const satisfies readonly CategoryAxis[];

const ArgsSchema = z.object({
  axis: z.enum(AXES).optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const RowSchema = z.object({
  axis: z.enum(AXES),
  id: z.string(),
  closed: z.boolean().optional(),
  dispatchable: z.boolean().optional(),
  tier: z.union([z.number(), z.string()]).optional(),
  path: z.string().optional(),
});

type Row = z.infer<typeof RowSchema>;

function rows(registry: CategoryRegistry, axis: CategoryAxis): Row[] {
  if (axis === 'status') return registry.status.map((entry) => ({ axis, ...entry }));
  if (axis === 'area') return registry.area.map((entry) => ({ axis, ...entry }));
  return registry[axis].map((id) => ({ axis, id }));
}

export default defineCommand<Args, Row[]>({
  name: 'category.list',
  description: 'Print the category registry (kind, status, cos, area), or one axis of it',
  args: ArgsSchema,
  result: z.array(RowSchema),
  cli: {
    options: {
      axis: { long: '--axis', description: 'kind|status|cos|area' },
    },
  },
  async run(args, ctx) {
    const registry = await loadCategoryRegistry(ctx.activeRoot);
    if (registry === null) {
      warn(
        ctx,
        `No category registry at ${categoriesPath(ctx.activeRoot)}: kind, cos and area are not ` +
          'validated. Seed one with `category init`.',
      );
      return [];
    }
    return (args.axis === undefined ? AXES : [args.axis]).flatMap((axis) => rows(registry, axis));
  },
});
