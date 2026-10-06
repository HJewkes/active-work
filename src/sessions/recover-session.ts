/**
 * Rebuild the record of a session that ended without a wrap (TP-1711).
 *
 * A reboot, a crash or a closed window leaves a transcript and no record, so
 * the next bootstrap opens on whatever session wrapped before it. Everything
 * written here is read from the transcript by session-read's `recoverSession`:
 * no model is called, and the record says so in its first line.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  claudeProjectSlug,
  claudeSourceFromPath,
  recoverSession,
  type TranscriptRoot,
} from '@titan-design/session-read';
import { NotFoundError, ValidationError } from '../errors.js';
import type { LiveSessionIds } from './live-claude-sessions.js';
import { loadSessionsFromDir } from './open-loops.js';
import { renderRecoveredBody } from './recovered-body.js';
import { writeSessionFile, type SessionWriteResult } from './session-file.js';

export interface InitiativeTranscript {
  sessionId: string;
  path: string;
  /** The transcript root's account, used as the source namespace. */
  namespace: string;
  mtimeMs: number;
}

export interface RecoverTarget {
  activeRoot: string;
  slug: string;
  track: 'canonical' | 'sidecar' | 'adhoc';
  roots: TranscriptRoot[];
  liveSessionIds: LiveSessionIds;
  now: Date;
}

/** A transcript written this recently may belong to a session still mid-turn. */
export const RECENT_WRITE_MS = 10 * 60_000;

/** Claude stamps `entrypoint` on every line; the first few kilobytes always carry one. */
const ENTRYPOINT_SCAN_BYTES = 64 * 1024;
const HEADLESS_ENTRYPOINT = 'sdk-cli';

async function transcriptsIn(root: TranscriptRoot, dir: string): Promise<InitiativeTranscript[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found: InitiativeTranscript[] = [];
  for (const name of names.filter((n) => n.endsWith('.jsonl') && !n.startsWith('agent-'))) {
    const file = path.join(dir, name);
    const { mtimeMs } = await fs.stat(file);
    found.push({
      sessionId: name.slice(0, -'.jsonl'.length),
      path: file,
      namespace: root.account,
      mtimeMs,
    });
  }
  return found;
}

/** Transcripts of sessions launched in the initiative's directory, newest first. */
async function initiativeTranscripts(target: RecoverTarget): Promise<InitiativeTranscript[]> {
  const projectDir = claudeProjectSlug(path.join(target.activeRoot, target.slug));
  const all: InitiativeTranscript[] = [];
  for (const root of target.roots) {
    all.push(...(await transcriptsIn(root, path.join(root.root, projectDir))));
  }
  return all.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Record filenames carry the session id (`session-file.ts`), so a filename
 * match finds a session's record even when its frontmatter no longer parses.
 */
async function recordedFilenames(activeRoot: string, slug: string): Promise<string[]> {
  try {
    return await fs.readdir(path.join(activeRoot, slug, 'sessions'));
  } catch {
    return [];
  }
}

export interface UnrecordedTranscripts {
  candidates: InitiativeTranscript[];
  recorded: Set<string>;
  live: Set<string>;
  fresh: Set<string>;
  all: InitiativeTranscript[];
}

export async function findUnrecordedTranscripts(
  target: RecoverTarget,
): Promise<UnrecordedTranscripts> {
  const all = await initiativeTranscripts(target);
  const filenames = await recordedFilenames(target.activeRoot, target.slug);
  const ids = (list: InitiativeTranscript[]) => new Set(list.map((t) => t.sessionId));
  const recorded = ids(all.filter((t) => filenames.some((f) => f.includes(t.sessionId))));
  const fresh = ids(all.filter((t) => target.now.getTime() - t.mtimeMs < RECENT_WRITE_MS));
  const live = await target.liveSessionIds();
  const candidates = all.filter(
    (t) => !recorded.has(t.sessionId) && !live.has(t.sessionId) && !fresh.has(t.sessionId),
  );
  return { candidates, recorded, live, fresh, all };
}

/** The `entrypoint` of the transcript's first line that has one; null when none does. */
async function entrypointOf(file: string): Promise<string | null> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(ENTRYPOINT_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, ENTRYPOINT_SCAN_BYTES, 0);
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      const match = /"entrypoint":"([^"]+)"/.exec(line);
      if (match) return match[1] ?? null;
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** When the newest record on the target's track ended; null when it has none. */
async function newestRecordEnded(target: RecoverTarget): Promise<number | null> {
  const { sessions } = await loadSessionsFromDir(path.join(target.activeRoot, target.slug));
  const ends = sessions
    .filter((s) => s.frontmatter.track === target.track)
    .map((s) => new Date(s.frontmatter.ended).getTime());
  return ends.length === 0 ? null : Math.max(...ends);
}

export interface NewestPick {
  chosen: InitiativeTranscript | undefined;
  /** Why nothing was chosen. */
  reason?: string;
}

/**
 * The newest interactive transcript that ended after the newest record on the
 * target's track. Older ones are history, not the last session, so a second
 * run finds nothing rather than walking back through them. A transcript's
 * mtime stands for when it ended.
 */
export async function pickNewest(
  target: RecoverTarget,
  found: UnrecordedTranscripts,
): Promise<NewestPick> {
  const since = await newestRecordEnded(target);
  for (const t of found.candidates.filter((c) => since === null || c.mtimeMs > since)) {
    if ((await entrypointOf(t.path)) !== HEADLESS_ENTRYPOINT) return { chosen: t };
  }
  const after =
    since === null
      ? ''
      : ` ended after the newest ${target.track} record (${new Date(since).toISOString()})`;
  return {
    chosen: undefined,
    reason:
      `No unrecorded interactive transcript${after}; nothing was written. ` +
      'Name an older one with --session.',
  };
}

/** The named session, refused when it is recorded, running, fresh, or not this initiative's. */
export function pickNamed(
  found: UnrecordedTranscripts,
  sessionId: string,
  slug: string,
): InitiativeTranscript {
  const transcript = found.all.find((t) => t.sessionId === sessionId);
  if (!transcript) {
    throw new NotFoundError(
      `No transcript for session ${sessionId} was launched in initiative ${slug}.`,
    );
  }
  if (found.recorded.has(sessionId)) {
    throw new ValidationError(
      `Session ${sessionId} already has a record in ${slug}; nothing to recover.`,
    );
  }
  if (found.live.has(sessionId)) {
    throw new ValidationError(
      `Session ${sessionId} is still running in a claude process; wrap it there instead.`,
    );
  }
  if (found.fresh.has(sessionId)) {
    throw new ValidationError(
      `Session ${sessionId} wrote its transcript in the last ${RECENT_WRITE_MS / 60_000} minutes ` +
        'and may still be running; try again later.',
    );
  }
  return transcript;
}

function isoOrFallback(value: string | null, fallbackMs: number): string {
  return value ?? new Date(fallbackMs).toISOString();
}

export async function writeRecoveredRecord(
  target: RecoverTarget,
  transcript: InitiativeTranscript,
): Promise<SessionWriteResult> {
  const source = claudeSourceFromPath(transcript.path, transcript.namespace);
  const recovery = await recoverSession(source, {
    root: path.join(target.activeRoot, target.slug),
  });
  const ended = isoOrFallback(recovery.endedAt, transcript.mtimeMs);
  return writeSessionFile({
    slug: target.slug,
    activeRoot: target.activeRoot,
    session_id: transcript.sessionId,
    started: recovery.startedAt ?? ended,
    ended,
    track: target.track,
    body: renderRecoveredBody(recovery),
    generated: true,
    transcript: transcript.path,
  });
}
