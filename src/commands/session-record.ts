import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SessionFrontmatterSchema } from '../schemas/session.js';
import { getInitiativeDir } from '../utils/paths.js';
import { writeFrontmatter } from '../utils/gray-matter-io.js';
import { ValidationError } from '../errors.js';
import { defineCommand } from '../registry/index.js';

const ArgsSchema = z.object({
  slug: z.string().min(1),
  session_id: z.string().min(1),
  started: z.string().min(1),
  ended: z.string().min(1),
  track: z.enum(['canonical', 'sidecar']),
  body: z.string(),
});

const ResultSchema = z.object({
  path: z.string(),
  filename: z.string(),
});

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

export default defineCommand({
  name: 'session.record',
  description: 'Write a session summary file under <slug>/sessions/',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['slug'],
    options: {
      session_id: {
        long: '--session-id',
        description: 'Claude session identifier',
        required: true,
      },
      started: {
        long: '--started',
        description: 'ISO 8601 session start timestamp',
        required: true,
      },
      ended: {
        long: '--ended',
        description: 'ISO 8601 session end timestamp',
        required: true,
      },
      track: {
        long: '--track',
        description: "'canonical' | 'sidecar' (default: canonical)",
      },
      body: {
        long: '--body',
        description: 'Raw markdown body',
      },
      body_file: {
        long: '--body-file',
        description: 'Path to a file containing the markdown body',
      },
    },
    usage: 'session.record <slug> --session-id <id> --started <iso> --ended <iso> [--track canonical|sidecar] (--body <text> | --body-file <path>)',
  },
  async run(args) {
    const sessionsDir = path.join(getInitiativeDir(args.slug), 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    const stamp = formatStartedStamp(args.started);
    const baseName = `${stamp}-${args.session_id}`;
    const { filename, fullPath } = await pickAvailableFilename(
      sessionsDir,
      baseName,
    );

    await writeFrontmatter(
      fullPath,
      {
        session_id: args.session_id,
        started: args.started,
        ended: args.ended,
        track: args.track,
      },
      args.body,
      SessionFrontmatterSchema,
    );

    return { path: fullPath, filename };
  },
});
