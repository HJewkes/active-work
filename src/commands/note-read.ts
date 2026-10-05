import { z } from 'zod';
import { UsageError, ValidationError } from '../errors.js';
import { NoteFrontmatterSchema, NoteKindSchema } from '../schemas/note.js';
import { readInitiativeFile } from '../sources/read.js';
import { coerceDates } from '../utils/coerce-dates.js';
import { parseFrontmatter } from '../utils/gray-matter-io.js';
import { getActiveRoot } from '../utils/paths.js';
import { validateSlug } from '../utils/slug.js';
import { itemId } from '../workspace-index/wire.js';
import { defineCommand } from '../registry/index.js';

const NOTES_PREFIX = 'sources/notes/';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  note: z.string().min(1),
});

const ResultSchema = z.object({
  // `<slug>:notes:<filename>`, the same id `note.list` returns.
  id: z.string(),
  slug: z.string(),
  filename: z.string(),
  // Relative to the initiative directory, `/`-separated.
  path: z.string(),
  kind: NoteKindSchema,
  title: z.string(),
  created: z.string(),
  tags: z.array(z.string()).optional(),
  read_if: z.string().optional(),
  body: z.string(),
  // True when the file exceeded the read cap and `body` holds only its head.
  truncated: z.boolean(),
});

type Args = z.infer<typeof ArgsSchema>;
type Result = z.infer<typeof ResultSchema>;

/** A bare filename, as `note.list` returns it, names a file in the notes directory. */
function requestedPath(note: string): string {
  return note.includes('/') ? note : `${NOTES_PREFIX}${note}`;
}

function parseNote(relativePath: string, content: string) {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(content);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Not a valid note: ${relativePath}: ${reason}`);
  }
  const result = NoteFrontmatterSchema.safeParse(coerceDates(parsed.data));
  if (!result.success) {
    throw new ValidationError(`Not a valid note: ${relativePath}: ${result.error.message}`);
  }
  return { frontmatter: result.data, body: parsed.content };
}

export default defineCommand<Args, Result>({
  name: 'note.read',
  description:
    "Read one durable note: its frontmatter fields and markdown body. Accepts the filename note.list returns, or a path in any form source.read accepts; refuses anything outside the initiative's sources/notes/.",
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug', 'note'],
    usage: 'active-work note read <slug> <filename|path>',
  },
  async run(args) {
    const slugCheck = validateSlug(args.slug);
    if (!slugCheck.ok) throw new UsageError(`Invalid slug '${args.slug}': ${slugCheck.error}`);
    const file = await readInitiativeFile(getActiveRoot(), args.slug, requestedPath(args.note));
    if (!file.path.startsWith(NOTES_PREFIX) || !file.path.endsWith('.md')) {
      throw new UsageError(`Not a note under ${NOTES_PREFIX}: ${file.path}`);
    }
    const { frontmatter, body } = parseNote(file.path, file.content);
    const filename = file.path.slice(NOTES_PREFIX.length);
    return {
      id: itemId(args.slug, 'notes', filename),
      slug: args.slug,
      filename,
      path: file.path,
      ...frontmatter,
      body,
      truncated: file.truncated,
    };
  },
});
