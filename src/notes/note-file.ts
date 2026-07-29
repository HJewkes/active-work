/**
 * Durable notes are the non-actionable half of what a session leaves behind:
 * process lessons, gotchas, decisions. Anything actionable becomes a task; this
 * is everything else that a future session would want to know and that no task
 * would ever carry.
 *
 * They live under `sources/notes/` as frontmatter + markdown, one file per
 * note. Unlike sessions they never age out of the bootstrap — a process lesson
 * from months ago is exactly the one that gets re-learned the hard way.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NoteFrontmatterSchema, type NoteFrontmatter } from '../schemas/note.js';
import { readFrontmatter, writeFrontmatter } from '../utils/gray-matter-io.js';
import { slugifyLabel } from '../commands/source-add.js';

/** A note file that parsed and validated. */
export interface LoadedNote {
  /** Filename including `.md`. */
  filename: string;
  path: string;
  frontmatter: NoteFrontmatter;
  body: string;
}

/** A file under `sources/notes/` that could not be read as a note. */
export interface MalformedNote {
  file: string;
  reason: string;
}

export interface LoadedNotes {
  notes: LoadedNote[];
  malformed: MalformedNote[];
}

/** Resolve the notes directory for an initiative directory. */
export function getNotesDir(initiativeDir: string): string {
  return path.join(initiativeDir, 'sources', 'notes');
}

/**
 * Newest first. Filenames start with `created`, so a descending filename sort
 * orders by date and breaks ties on the title slug — deterministic without
 * depending on mtime.
 */
function compareNewestFirst(a: LoadedNote, b: LoadedNote): number {
  return b.filename.localeCompare(a.filename);
}

/**
 * Read every note for an initiative, newest first.
 *
 * Never throws: a missing `sources/notes/` yields an empty result, and a file
 * that will not parse comes back as `malformed` rather than vanishing. A note
 * silently dropped is knowledge silently lost, which is the failure mode the
 * whole feature exists to prevent.
 */
export async function loadNotesFromDir(initiativeDir: string): Promise<LoadedNotes> {
  const dir = getNotesDir(initiativeDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { notes: [], malformed: [] };
  }
  const notes: LoadedNote[] = [];
  const malformed: MalformedNote[] = [];
  for (const filename of entries.filter((n) => n.endsWith('.md')).sort()) {
    const fullPath = path.join(dir, filename);
    try {
      const { frontmatter, body } = await readFrontmatter(fullPath, NoteFrontmatterSchema);
      notes.push({ filename, path: fullPath, frontmatter, body });
    } catch (err) {
      malformed.push({
        file: filename,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { notes: notes.sort(compareNewestFirst), malformed };
}

export interface NoteWriteResult {
  path: string;
  filename: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Two notes filed the same day under the same title are two notes, not one —
 * park the second beside the first rather than overwriting knowledge already
 * captured.
 */
async function pickAvailableFilename(dir: string, baseName: string): Promise<string> {
  if (!(await exists(path.join(dir, `${baseName}.md`)))) return `${baseName}.md`;
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${baseName}-${i}.md`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  throw new Error(`Could not find an available filename for ${baseName}`);
}

/**
 * Write `<initiativeDir>/sources/notes/<created>-<title-slug>.md`, validating
 * the frontmatter first.
 */
export async function writeNoteFile(
  initiativeDir: string,
  frontmatter: NoteFrontmatter,
  body: string,
): Promise<NoteWriteResult> {
  const dir = getNotesDir(initiativeDir);
  await fs.mkdir(dir, { recursive: true });
  const baseName = `${frontmatter.created}-${slugifyLabel(frontmatter.title)}`;
  const filename = await pickAvailableFilename(dir, baseName);
  const fullPath = path.join(dir, filename);
  await writeFrontmatter(fullPath, frontmatter, body, NoteFrontmatterSchema);
  return { path: fullPath, filename };
}
