import { z } from 'zod';
import { NoteKindSchema } from '../schemas/note.js';
import { loadNotesFromDir, type LoadedNote } from '../notes/note-file.js';
import { getInitiativeDir } from '../utils/paths.js';
import { defineCommand } from '../registry/index.js';
import { resolveListSlugs } from './_list-scope.js';

const ArgsSchema = z.object({
  slug: z.string().min(1).optional(),
  all_initiatives: z.boolean().optional(),
  kind: NoteKindSchema.optional(),
});

const NoteEntrySchema = z.object({
  slug: z.string(),
  filename: z.string(),
  path: z.string(),
  kind: NoteKindSchema,
  title: z.string(),
  created: z.string(),
  tags: z.array(z.string()).optional(),
});

const ResultSchema = z.object({
  notes: z.array(NoteEntrySchema),
  // Unreadable files are reported, never dropped: a note that silently
  // disappears is exactly the knowledge loss notes exist to prevent.
  errors: z.array(z.object({ slug: z.string(), filename: z.string(), error: z.string() })),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

function toEntry(slug: string, note: LoadedNote): z.infer<typeof NoteEntrySchema> {
  return {
    slug,
    filename: note.filename,
    path: note.path,
    kind: note.frontmatter.kind,
    title: note.frontmatter.title,
    created: note.frontmatter.created,
    ...(note.frontmatter.tags ? { tags: note.frontmatter.tags } : {}),
  };
}

async function listForSlug(slug: string, kind: Args['kind']): Promise<Result> {
  const { notes, malformed } = await loadNotesFromDir(getInitiativeDir(slug));
  const selected = kind ? notes.filter((note) => note.frontmatter.kind === kind) : notes;
  return {
    notes: selected.map((note) => toEntry(slug, note)),
    errors: malformed.map((entry) => ({ slug, filename: entry.file, error: entry.reason })),
  };
}

/** Across initiatives, newest first on `created`, then filename for a stable order. */
function newestFirst(a: z.infer<typeof NoteEntrySchema>, b: z.infer<typeof NoteEntrySchema>) {
  return b.created.localeCompare(a.created) || b.filename.localeCompare(a.filename);
}

export default defineCommand<Args, Result>({
  name: 'note.list',
  description:
    'List durable notes for an initiative, or across every initiative with all_initiatives, newest first.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      all_initiatives: {
        long: '--all-initiatives',
        description: 'List notes from every initiative under the active root',
      },
      kind: {
        long: '--kind',
        description: 'Only notes of this kind: process | gotcha | fyi | decision | plan',
      },
    },
    usage:
      'active-work note list <slug>|--all-initiatives [--kind process|gotcha|fyi|decision|plan]',
  },
  async run(args) {
    const slugs = await resolveListSlugs('note.list', args);
    const perSlug = await Promise.all(slugs.map((slug) => listForSlug(slug, args.kind)));
    const notes = perSlug.flatMap((r) => r.notes);
    return {
      notes: slugs.length > 1 ? notes.sort(newestFirst) : notes,
      errors: perSlug.flatMap((r) => r.errors),
    };
  },
});
