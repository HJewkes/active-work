import { z } from 'zod';
import { NoteKindSchema } from '../schemas/note.js';
import { loadNotesFromDir, type LoadedNote } from '../notes/note-file.js';
import { getActiveRoot, getInitiativeDir } from '../utils/paths.js';
import { defineCommand } from '../registry/index.js';
import { itemId, mtimeOf } from '../workspace-index/wire.js';
import { humanOnlyPredicate, resolveListSlugs } from './_list-scope.js';

const ArgsSchema = z.object({
  slug: z.string().min(1).optional(),
  all_initiatives: z.boolean().optional(),
  kind: NoteKindSchema.optional(),
});

const NoteEntrySchema = z.object({
  // `<slug>:notes:<filename>`, unique across initiatives.
  id: z.string(),
  slug: z.string(),
  filename: z.string(),
  // Absolute.
  path: z.string(),
  kind: NoteKindSchema,
  title: z.string(),
  created: z.string(),
  tags: z.array(z.string()).optional(),
  // The charter marks the initiative human-only; true for all when the charter is unreadable.
  human_only: z.boolean(),
  // ISO timestamp; null only when the file vanished mid-listing.
  mtime: z.string().nullable(),
});

const ResultSchema = z.object({
  notes: z.array(NoteEntrySchema),
  // Unreadable files are reported, never dropped: a note that silently
  // disappears is exactly the knowledge loss notes exist to prevent.
  errors: z.array(z.object({ slug: z.string(), filename: z.string(), error: z.string() })),
  // False when the charter is unreadable; every note is then flagged human_only.
  human_only_known: z.boolean(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;
type Entry = z.infer<typeof NoteEntrySchema>;
type SlugListing = Pick<Result, 'notes' | 'errors'>;

async function toEntry(slug: string, note: LoadedNote, humanOnly: boolean): Promise<Entry> {
  return {
    id: itemId(slug, 'notes', note.filename),
    slug,
    filename: note.filename,
    path: note.path,
    kind: note.frontmatter.kind,
    title: note.frontmatter.title,
    created: note.frontmatter.created,
    ...(note.frontmatter.tags ? { tags: note.frontmatter.tags } : {}),
    human_only: humanOnly,
    mtime: await mtimeOf(note.path),
  };
}

async function listForSlug(
  slug: string,
  kind: Args['kind'],
  humanOnly: boolean,
): Promise<SlugListing> {
  const { notes, malformed } = await loadNotesFromDir(getInitiativeDir(slug));
  const selected = kind ? notes.filter((note) => note.frontmatter.kind === kind) : notes;
  return {
    notes: await Promise.all(selected.map((note) => toEntry(slug, note, humanOnly))),
    errors: malformed.map((entry) => ({ slug, filename: entry.file, error: entry.reason })),
  };
}

/** Across initiatives, newest first on `created`, then filename for a stable order. */
function newestFirst(a: Entry, b: Entry) {
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
  async run(args, ctx) {
    const [slugs, humanOnly] = await Promise.all([
      resolveListSlugs('note.list', args),
      humanOnlyPredicate(getActiveRoot(), ctx.warnings),
    ]);
    const perSlug = await Promise.all(
      slugs.map((slug) => listForSlug(slug, args.kind, humanOnly.isHumanOnly(slug))),
    );
    const notes = perSlug.flatMap((r) => r.notes);
    return {
      notes: slugs.length > 1 ? notes.sort(newestFirst) : notes,
      errors: perSlug.flatMap((r) => r.errors),
      human_only_known: humanOnly.known,
    };
  },
});
