import path from 'node:path';
import { z } from 'zod';
import { inferType, listSources, readTitle, type SourceEntry } from '../sources/list.js';
import { lintSources } from '../lint/sources.js';
import { getActiveRoot, getInitiativeDir } from '../utils/paths.js';
import { scanNestedSources, type InventoryFile } from '../workspace-index/inventory.js';
import { itemId, mtimeOf } from '../workspace-index/wire.js';
import { defineCommand } from '../registry/index.js';
import { resolveListSlugs } from './_list-scope.js';

const SourceTypeSchema = z.enum(['pr', 'deepdive', 'session', 'pointer']);

const ArgsSchema = z.object({
  slug: z.string().min(1).optional(),
  all_initiatives: z.boolean().optional(),
  type: SourceTypeSchema.optional(),
  nested: z.boolean().optional(),
});

const SourceEntrySchema = z.object({
  // `<slug>:sources:<filename>`, unique across initiatives.
  id: z.string(),
  slug: z.string(),
  // Relative to `sources/`: a bare filename at the top level, `<dir>/.../<file>` when nested.
  filename: z.string(),
  // Absolute, top-level and nested alike.
  path: z.string(),
  type: SourceTypeSchema,
  title: z.string(),
  // Under a `sources/` subdirectory: listed by path, not in the search index.
  nested: z.boolean(),
  // ISO timestamp; null only when the file vanished mid-listing.
  mtime: z.string().nullable(),
});

const ResultSchema = z.object({
  sources: z.array(SourceEntrySchema),
  // Drift between the directory and brief.md's hand-written references. Empty
  // when the brief keeps no reference list at all. Prefixed `<slug>: ` when
  // more than one initiative is listed.
  drift: z.array(z.string()),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;
type Entry = z.infer<typeof SourceEntrySchema>;

async function topLevelEntry(slug: string, entry: SourceEntry): Promise<Entry> {
  const id = itemId(slug, 'sources', entry.filename);
  return { id, slug, ...entry, nested: false, mtime: await mtimeOf(entry.path) };
}

/** Titles come from markdown headings only; other nested files are named by their path. */
async function nestedEntry(slug: string, sourcesDir: string, file: InventoryFile): Promise<Entry> {
  const filename = path.relative(sourcesDir, file.absolutePath).split(path.sep).join('/');
  const base = path.basename(filename);
  const title = base.endsWith('.md') ? await readTitle(file.absolutePath, base) : filename;
  return {
    id: itemId(slug, 'sources', filename),
    slug,
    filename,
    path: file.absolutePath,
    type: inferType(base),
    title,
    nested: true,
    mtime: file.mtime,
  };
}

async function entriesForSlug(slug: string, nested: boolean): Promise<Entry[]> {
  const initiativeDir = getInitiativeDir(slug);
  const listed = await listSources(initiativeDir);
  const top = await Promise.all(listed.map((entry) => topLevelEntry(slug, entry)));
  if (!nested) return top;
  const sourcesDir = path.join(initiativeDir, 'sources');
  const files = await scanNestedSources(getActiveRoot(), slug);
  return [...top, ...(await Promise.all(files.map((f) => nestedEntry(slug, sourcesDir, f))))];
}

async function driftForSlug(slug: string, prefixed: boolean): Promise<string[]> {
  const findings = await lintSources(slug, getInitiativeDir(slug));
  return findings.map((finding) => (prefixed ? `${slug}: ${finding.message}` : finding.message));
}

export default defineCommand<Args, Result>({
  name: 'source.list',
  description:
    "List an initiative's sources, or every initiative's with all_initiatives, derived by reading sources/*.md — never a stored index. With nested, also list files under sources/<dir>/ by path.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      all_initiatives: {
        long: '--all-initiatives',
        description: 'List sources from every initiative under the active root',
      },
      type: {
        long: '--type',
        description: 'Only sources of this type: pr | deepdive | session | pointer',
      },
      nested: {
        long: '--nested',
        description: 'Also list files under sources/<dir>/ (not notes/) by path',
      },
    },
    usage:
      'active-work source list <slug>|--all-initiatives [--type pr|deepdive|session|pointer] [--nested]',
  },
  async run(args) {
    const slugs = await resolveListSlugs('source.list', args);
    const prefixed = slugs.length > 1;
    const [entries, drift] = await Promise.all([
      Promise.all(slugs.map((slug) => entriesForSlug(slug, args.nested ?? false))),
      Promise.all(slugs.map((slug) => driftForSlug(slug, prefixed))),
    ]);
    const sources = entries.flat();
    return {
      sources: args.type ? sources.filter((entry) => entry.type === args.type) : sources,
      drift: drift.flat(),
    };
  },
});
