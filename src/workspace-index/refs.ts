import path from 'node:path';
import { refKind } from '@titan-design/store-sqlite';

/**
 * The five workspace ref kinds, and the rule that every stored path is
 * relative to the active root.
 *
 * `session` and `task` deliberately collide with the refs
 * `@titan-design/session-graph` already mints from transcripts. A workspace
 * session record and a mined transcript describe the same session from two
 * sides — the operator's summary and the machine's observation — and sharing
 * the ref joins them without either side learning the other's schema. Do not
 * disambiguate them.
 */

export const initiativeRef = refKind('initiative');
export const noteRef = refKind('note');
export const taskRef = refKind('task');
export const sessionRef = refKind('session');
export const sourceRef = refKind('source');

/**
 * Post-mortem finding F1, in one function. Brain stored absolute paths, the
 * repository moved, and 5,013 of 5,065 notes detached from files that were
 * sitting there the whole time — nothing noticed, because nothing ever checked
 * that a stored path still opened.
 *
 * So the index stores what the active root cannot invalidate, and the root is
 * resolved at open time. `doctor`'s `workspace-index` check is the other half.
 */
export function toRelative(activeRoot: string, absolutePath: string): string {
  return path.relative(activeRoot, absolutePath).split(path.sep).join('/');
}

export function toAbsolute(activeRoot: string, relativePath: string): string {
  return path.join(activeRoot, ...relativePath.split('/'));
}
