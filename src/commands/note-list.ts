import { z } from 'zod';
import { NoteKindSchema } from '../schemas/note.js';
import { loadNotesFromDir } from '../notes/note-file.js';
import { getInitiativeDir } from '../utils/paths.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  kind: NoteKindSchema.optional(),
});

const NoteEntrySchema = z.object({
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
  errors: z.array(z.object({ filename: z.string(), error: z.string() })),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'note.list',
  description: 'List durable notes for an initiative, newest first.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      kind: {
        long: '--kind',
        description: 'Only notes of this kind: process | gotcha | fyi | decision',
      },
    },
    usage: 'active-work note list <slug> [--kind process|gotcha|fyi|decision]',
  },
  async run(args) {
    const { notes, malformed } = await loadNotesFromDir(getInitiativeDir(args.slug));
    const selected = args.kind
      ? notes.filter((note) => note.frontmatter.kind === args.kind)
      : notes;
    return {
      notes: selected.map((note) => ({
        filename: note.filename,
        path: note.path,
        kind: note.frontmatter.kind,
        title: note.frontmatter.title,
        created: note.frontmatter.created,
        ...(note.frontmatter.tags ? { tags: note.frontmatter.tags } : {}),
      })),
      errors: malformed.map((entry) => ({
        filename: entry.file,
        error: entry.reason,
      })),
    };
  },
});
