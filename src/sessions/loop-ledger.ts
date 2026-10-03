/**
 * Loops filed outside a wrap (TP-913).
 *
 * A promise made mid-session died with the session, because only `wrap` could
 * write the ledger. Each entry here is a one-entry session record, so the
 * ledger is still derived from `sessions/` and there is no second store.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NextStep, SessionResolve } from '../schemas/session.js';
import { NotFoundError, ValidationError } from '../errors.js';
import {
  deriveOpenLoopsFrom,
  deriveResolvedLoopsFrom,
  type LoadedSessions,
  type OpenLoop,
  type ResolvedLoop,
} from './open-loops.js';
import { writeSessionFile } from './session-file.js';

export interface LedgerTarget {
  slug: string;
  activeRoot: string;
}

export interface LedgerEntry {
  path: string;
  /** Stem of the record written; the identity half of a ref it opens. */
  sessionFile: string;
  /** ISO timestamp the record carries as `started` and `ended`. */
  at: string;
}

type Ledger = { next_steps: NextStep[] } | { resolves: SessionResolve[] };

export async function assertInitiativeExists({ slug, activeRoot }: LedgerTarget): Promise<void> {
  try {
    await fs.access(path.join(activeRoot, slug, 'brief.md'));
  } catch {
    throw new NotFoundError(`Initiative not found: ${slug}`);
  }
}

/** One id per record: derivation rejects a resolve that shares the opener's session id. */
function ledgerSessionId(): string {
  return `loop-${randomBytes(4).toString('hex')}`;
}

async function writeEntry(
  target: LedgerTarget,
  at: Date,
  body: string,
  ledger: Ledger,
): Promise<LedgerEntry> {
  const stamp = at.toISOString();
  const written = await writeSessionFile({
    ...target,
    session_id: ledgerSessionId(),
    started: stamp,
    ended: stamp,
    track: 'adhoc',
    body,
    ...ledger,
  });
  return { path: written.path, sessionFile: written.filename.replace(/\.md$/, ''), at: stamp };
}

/** MUST run inside the initiative lock. */
export async function recordLoopOpen(
  target: LedgerTarget,
  step: NextStep,
  now: Date,
): Promise<LedgerEntry & { ref: string }> {
  const body = `Loop opened outside wrap: ${step.text}\n`;
  const entry = await writeEntry(target, now, body, { next_steps: [step] });
  return { ...entry, ref: `${entry.sessionFile}#${step.id}` };
}

function alreadyClosed(loop: ResolvedLoop, slug: string): ValidationError {
  const why = loop.note === undefined ? '' : ` ("${loop.note}")`;
  return new ValidationError(
    `Loop ${loop.ref} is already closed: ${loop.outcome} by ${loop.closedBy} at ` +
      `${loop.closedAt}${why}. Nothing was written. If a different loop is the one that ` +
      `finished, find its ref with \`active-work loops ${slug}\`.`,
  );
}

/**
 * The one open loop `id` names: a full `<session file stem>#<id>` ref, or a
 * bare next_step id when exactly one open loop carries it.
 *
 * A closed loop is an error, not a no-op. Wrap accepts a second resolve of a
 * closed ref, which is how a mistyped id once "closed" a finished loop and left
 * the live one open with nobody told.
 */
export function findLoopToClose(
  loaded: LoadedSessions,
  id: string,
  slug: string,
  now: Date,
): OpenLoop {
  const names = (ref: string): boolean =>
    ref === id || (!id.includes('#') && ref.endsWith(`#${id}`));
  const open = deriveOpenLoopsFrom(loaded, { now }).filter((loop) => names(loop.ref));
  if (open.length === 1) return open[0]!;
  if (open.length > 1) {
    const refs = open.map((loop) => loop.ref).join(', ');
    throw new ValidationError(
      `"${id}" names ${open.length} open loops; pass one full ref: ${refs}`,
    );
  }
  const closed = deriveResolvedLoopsFrom(loaded, { now }).find((loop) => names(loop.ref));
  if (closed) throw alreadyClosed(closed, slug);
  throw new NotFoundError(
    `No loop matches "${id}" in ${slug}. List refs with \`active-work loops ${slug} --state all\`.`,
  );
}

/**
 * MUST run inside the initiative lock.
 *
 * Only a strictly later record closes a loop, so the stamp is pushed past the
 * opener's when the clock has not moved on (or the opener's `ended` is ahead).
 */
export async function recordLoopResolve(
  target: LedgerTarget,
  loop: OpenLoop,
  resolution: Omit<SessionResolve, 'ref'>,
  now: Date,
): Promise<LedgerEntry> {
  const at = new Date(Math.max(now.getTime(), new Date(loop.openedAt).getTime() + 1));
  const verb = resolution.outcome === 'done' ? 'resolved' : 'abandoned';
  const why = resolution.note === undefined ? '' : `\n\n${resolution.note}`;
  const body = `Loop ${verb} outside wrap: ${loop.text}${why}\n`;
  return writeEntry(target, at, body, { resolves: [{ ref: loop.ref, ...resolution }] });
}
