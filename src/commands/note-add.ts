import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { NOTE_TITLE_MAX_LENGTH, NoteKindSchema } from '../schemas/note.js';
import { writeNoteFile } from '../notes/note-file.js';
import { getInitiativeDir, getLockPath } from '../utils/paths.js';
import { withFileLock } from '../utils/fs-atomic.js';
import { today } from '../utils/today.js';
import { NotFoundError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z
  .object({
    slug: z.string().min(1),
    kind: NoteKindSchema,
    title: z
      .string()
      .min(1)
      .max(NOTE_TITLE_MAX_LENGTH, {
        message: `Title must be at most ${NOTE_TITLE_MAX_LENGTH} characters — it is slugified into the filename`,
      }),
    body: z.string().optional(),
    body_file: z.string().optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    const hasBody = value.body !== undefined;
    const hasFile = value.body_file !== undefined;
    if (!hasBody && !hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'Exactly one of --body or --body-file is required',
      });
    }
    if (hasBody && hasFile) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: '--body and --body-file are mutually exclusive',
      });
    }
  });

const ResultSchema = z.object({
  path: z.string(),
  filename: z.string(),
  kind: NoteKindSchema,
  title: z.string(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'note.add',
  description:
    'File a durable note under <slug>/sources/notes/ — a process lesson, gotcha, decision, or FYI that a future session needs but that no task would carry. Actionable work belongs in `task add` instead.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      kind: {
        long: '--kind',
        description: 'process | gotcha | fyi | decision',
        required: true,
      },
      title: {
        long: '--title',
        description: `Short title, at most ${NOTE_TITLE_MAX_LENGTH} chars (slugified into the filename)`,
        required: true,
      },
      body: { long: '--body', description: 'Raw markdown body' },
      body_file: {
        long: '--body-file',
        description: 'Path to a file containing the markdown body',
      },
      tags: { long: '--tags', description: 'Comma-separated tags' },
    },
    usage:
      'active-work note add <slug> --kind <process|gotcha|fyi|decision> --title <text> (--body <text> | --body-file <path>) [--tags a,b]',
  },
  async run(args) {
    const initiativeDir = getInitiativeDir(args.slug);
    try {
      await fs.access(path.join(initiativeDir, 'brief.md'));
    } catch {
      throw new NotFoundError(`Initiative not found: ${args.slug}`);
    }

    const body = args.body ?? (await fs.readFile(args.body_file!, 'utf8'));
    const frontmatter = {
      kind: args.kind,
      title: args.title,
      created: today(),
      ...(args.tags && args.tags.length > 0 ? { tags: args.tags } : {}),
    };

    return withFileLock(getLockPath(args.slug), async () => {
      const written = await writeNoteFile(initiativeDir, frontmatter, body);
      return { ...written, kind: args.kind, title: args.title };
    });
  },
});
