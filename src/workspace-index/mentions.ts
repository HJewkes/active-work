import { noteRef, sessionRef, sourceRef, taskRef } from './refs.js';

/**
 * `note:X mentions <ref>` — exact, token-bounded id matches in a note body.
 *
 * This is the relation that links a note in one initiative to a task or session
 * in another, and it is deliberately literal. It fires when a note *names* an
 * id; it will not connect two notes that describe the same problem in different
 * words. That is FTS's job, and later the vectors'. The edge table is for what
 * the files state, the ranker is for what they imply — keeping that line clean
 * is post-mortem findings F2 and F3 together.
 *
 * Every candidate is filtered against refs the index actually holds, so a
 * `UTF-8` or a `sha-256` in prose costs one set lookup and produces nothing.
 */

/** Every ref the index holds, in the shapes a body can name. */
export interface RefIndex {
  /** Bare task ids, upper-cased. */
  taskIds: Set<string>;
  sessionIds: Set<string>;
  noteRefs: Set<string>;
  /** `<slug>/<path>` for every source, so `sources/x.md` resolves inside its own initiative. */
  sourcePaths: Set<string>;
}

/** Token bounds copied from `context.graph`, so both commands join ids the same way. */
const TASK_ID = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-\d+)(?![A-Za-z0-9])/g;
const SESSION_ID =
  /(?<![A-Za-z0-9_-])(session_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![A-Za-z0-9-])/gi;
const NOTE_REF = /(?<![A-Za-z0-9])note:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.md)/g;
const SOURCE_PATH = /sources\/([A-Za-z0-9._/-]+\.md)/g;

function matches(body: string, pattern: RegExp): string[] {
  return [...body.matchAll(pattern)].map((match) => match[1]);
}

/**
 * Refs a note body names. `initiative` scopes the bare `sources/x.md` form,
 * which is initiative-relative by construction; task and session ids are
 * globally shaped and so cross initiatives freely, which is the point.
 */
export function extractMentions(body: string, initiative: string, index: RefIndex): string[] {
  const found = new Set<string>();
  for (const id of matches(body, TASK_ID)) {
    if (index.taskIds.has(id.toUpperCase())) found.add(taskRef(id.toUpperCase()));
  }
  for (const id of matches(body, SESSION_ID)) {
    if (index.sessionIds.has(id)) found.add(sessionRef(id));
  }
  for (const id of matches(body, NOTE_REF)) {
    if (index.noteRefs.has(noteRef(id))) found.add(noteRef(id));
  }
  for (const path of matches(body, SOURCE_PATH)) {
    const scoped = `${initiative}/${path}`;
    if (index.sourcePaths.has(scoped)) found.add(sourceRef(scoped));
  }
  return [...found].sort();
}
