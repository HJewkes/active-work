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
}

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
export async function initiativeTranscripts(
  target: Pick<RecoverTarget, 'activeRoot' | 'slug' | 'roots'>,
): Promise<InitiativeTranscript[]> {
  const projectDir = claudeProjectSlug(path.join(target.activeRoot, target.slug));
  const all: InitiativeTranscript[] = [];
  for (const root of target.roots)
    all.push(...(await transcriptsIn(root, path.join(root.root, projectDir))));
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
  all: InitiativeTranscript[];
}

export async function findUnrecordedTranscripts(
  target: RecoverTarget,
): Promise<UnrecordedTranscripts> {
  const all = await initiativeTranscripts(target);
  const filenames = await recordedFilenames(target.activeRoot, target.slug);
  const recorded = new Set(
    all.filter((t) => filenames.some((f) => f.includes(t.sessionId))).map((t) => t.sessionId),
  );
  const live = await target.liveSessionIds();
  const candidates = all.filter((t) => !recorded.has(t.sessionId) && !live.has(t.sessionId));
  return { candidates, recorded, live, all };
}

/** The named session, refused when it is recorded, running, or not this initiative's. */
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
