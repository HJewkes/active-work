import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  SessionFrontmatterSchema,
  type NextStep,
  type SessionResolve,
} from '../schemas/session.js';
import { getInitiativeDir } from '../utils/paths.js';
import { writeFrontmatter } from '../utils/gray-matter-io.js';
import { ValidationError } from '../errors.js';

export interface SessionWriteInput {
  slug: string;
  session_id: string;
  started: string;
  ended: string;
  track: 'canonical' | 'sidecar' | 'adhoc';
  body: string;
  next_steps?: NextStep[];
  resolves?: SessionResolve[];
  no_loops?: true;
}

export interface SessionWriteResult {
  path: string;
  filename: string;
}

function formatStartedStamp(started: string): string {
  const parsed = new Date(started);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`Invalid started timestamp: ${started}`);
  }
  const yyyy = parsed.getUTCFullYear().toString().padStart(4, '0');
  const mm = (parsed.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = parsed.getUTCDate().toString().padStart(2, '0');
  const hh = parsed.getUTCHours().toString().padStart(2, '0');
  const min = parsed.getUTCMinutes().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}-${hh}${min}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function pickAvailableFilename(
  dir: string,
  baseName: string,
): Promise<{ filename: string; fullPath: string }> {
  const initial = `${baseName}.md`;
  const initialPath = path.join(dir, initial);
  if (!(await exists(initialPath))) {
    return { filename: initial, fullPath: initialPath };
  }
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${baseName}-${i}.md`;
    const candidatePath = path.join(dir, candidate);
    if (!(await exists(candidatePath))) {
      return { filename: candidate, fullPath: candidatePath };
    }
  }
  throw new Error(`Could not find an available filename for ${baseName}`);
}

/**
 * Write `<slug>/sessions/<YYYY-MM-DD-HHMM>-<session_id>.md`, validating the
 * frontmatter first. `wrap` is the only command that writes sessions through
 * here; `fold` writes its derived sidecars directly.
 */
export async function writeSessionFile(
  input: SessionWriteInput,
): Promise<SessionWriteResult> {
  const sessionsDir = path.join(getInitiativeDir(input.slug), 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });

  const baseName = `${formatStartedStamp(input.started)}-${input.session_id}`;
  const { filename, fullPath } = await pickAvailableFilename(sessionsDir, baseName);

  await writeFrontmatter(
    fullPath,
    {
      session_id: input.session_id,
      started: input.started,
      ended: input.ended,
      track: input.track,
      next_steps: input.next_steps ?? [],
      resolves: input.resolves ?? [],
      ...(input.no_loops === true ? { no_loops: true } : {}),
    },
    input.body,
    SessionFrontmatterSchema,
  );

  return { path: fullPath, filename };
}
