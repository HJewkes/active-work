import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ArtifactsSchema, type Artifacts } from '../schemas/artifacts.js';
import { getActiveRoot, getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { readYaml } from '../utils/yaml-io.js';
import { UsageError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().optional(),
  all_initiatives: z.boolean().optional(),
});

const ItemSchema = z.object({
  slug: z.string(),
  artifacts: ArtifactsSchema,
});

const ResultSchema = z.object({
  items: z.array(ItemSchema),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

async function readForSlug(slug: string): Promise<Artifacts> {
  const artifactsPath = path.join(getInitiativeDir(slug), 'artifacts.yml');
  return withFileLock(getLockPath(slug), () =>
    readYaml(artifactsPath, ArtifactsSchema),
  );
}

async function listInitiativeSlugs(): Promise<string[]> {
  const root = getActiveRoot();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const artifactsPath = path.join(root, entry.name, 'artifacts.yml');
    try {
      await fs.access(artifactsPath);
      slugs.push(entry.name);
    } catch {
      // skip dirs without artifacts.yml
    }
  }
  slugs.sort();
  return slugs;
}

export default defineCommand<Args, Result>({
  name: 'artifact.list',
  description: 'List artifacts for a slug or across all initiatives.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      all_initiatives: {
        long: '--all-initiatives',
        description: 'Return artifacts for every initiative',
      },
    },
  },
  async run(args) {
    if (args.all_initiatives) {
      const slugs = await listInitiativeSlugs();
      const items: Array<{ slug: string; artifacts: Artifacts }> = [];
      for (const slug of slugs) {
        items.push({ slug, artifacts: await readForSlug(slug) });
      }
      return { items };
    }
    if (!args.slug) {
      throw new UsageError(
        'artifact.list requires <slug> or --all-initiatives',
      );
    }
    const artifacts = await readForSlug(args.slug);
    return { items: [{ slug: args.slug, artifacts }] };
  },
});
