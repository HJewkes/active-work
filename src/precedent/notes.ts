import path from 'node:path';
import { listInitiativeSlugs } from '../lint/index.js';
import { loadNotesFromDir, type LoadedNote } from '../notes/note-file.js';
import { classifyQuestion } from './classify.js';
import type { PrecedentRow } from './schema.js';

/**
 * Precedents written down rather than asked: `kind: decision` notes, and
 * memories imported as notes whose original type was `feedback` (the human
 * saying how they want things done).
 */

const IMPORT_TRAILER = /\n---\nImported \d{4}-\d{2}-\d{2} from Claude Code memory[\s\S]*$/;
const FEEDBACK_TRAILER = /\(type: feedback\b/;
const MAX_ANSWER_CHARS = 4000;

function isPrecedentNote(note: LoadedNote): boolean {
  if (note.frontmatter.kind === 'decision') return true;
  const tags = note.frontmatter.tags ?? [];
  if (!tags.includes('memory-import')) return false;
  return tags.includes('feedback') || FEEDBACK_TRAILER.test(note.body);
}

function noteRow(slug: string, note: LoadedNote): PrecedentRow {
  const title = note.frontmatter.title;
  return {
    key: `note:${slug}/${note.filename}`,
    source: 'note',
    asked_at: String(note.frontmatter.created),
    session_id: null,
    tool_use_id: null,
    initiative: slug,
    class: classifyQuestion({ header: '', question: title, options: [] }),
    header: null,
    question: title,
    options: [],
    recommended: null,
    answer: note.body.replace(IMPORT_TRAILER, '').trim().slice(0, MAX_ANSWER_CHARS),
    pick_type: 'none',
    free_text: null,
  };
}

export async function extractNoteRows(activeRoot: string): Promise<PrecedentRow[]> {
  const rows: PrecedentRow[] = [];
  for (const slug of await listInitiativeSlugs(activeRoot)) {
    const { notes } = await loadNotesFromDir(path.join(activeRoot, slug));
    rows.push(...notes.filter(isPrecedentNote).map((note) => noteRow(slug, note)));
  }
  return rows;
}
