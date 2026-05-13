import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { getInitiativeDir } from '../utils/paths.js';
import { writeFrontmatter } from '../utils/gray-matter-io.js';
import { SessionFrontmatterSchema } from '../schemas/session.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../utils/today.js';
import { appendTriagedLog } from '../discover/triaged-log.js';

/**
 * `active-work fold <ref> --into <slug>` — record that a discover hit has been
 * absorbed by an existing initiative.
 *
 * Side effects:
 *  - writes a `sidecar`-track session file under the initiative's
 *    `sessions/` so the fold is visible in the audit trail
 *  - appends a `fold` line to `<activeRoot>/.triaged.log` so future
 *    discovers suppress this ref
 */

const ArgsSchema = z.object({
  ref: z.string().min(1),
  into: z.string().min(1),
  note: z.string().optional(),
});

const ResultSchema = z.object({
  ref: z.string(),
  into: z.string(),
  session_file: z.string(),
});

export default defineCommand({
  name: 'fold',
  description: 'Mark a discover hit as folded into an existing initiative.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    positional: ['ref'],
    options: {
      into: {
        long: '--into',
        description: 'Slug of the initiative this hit is folded into',
        required: true,
      },
      note: {
        long: '--note',
        description: 'Optional human note describing the fold',
      },
    },
  },
  async run(args) {
    const initiativeDir = getInitiativeDir(args.into);
    try {
      const stat = await fs.stat(initiativeDir);
      if (!stat.isDirectory()) {
        throw new NotFoundError(`Initiative not found: ${args.into}`);
      }
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      throw new NotFoundError(`Initiative not found: ${args.into}`);
    }

    const sessionsDir = path.join(initiativeDir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });

    const startedIso = nowIso();
    const filename = buildSessionFilename(startedIso, args.ref);
    const sessionFile = path.join(sessionsDir, filename);

    const body = [
      `Folded hit \`${args.ref}\` into initiative \`${args.into}\`.`,
      '',
      args.note ? args.note : '_No note provided._',
    ].join('\n');

    await writeFrontmatter(
      sessionFile,
      {
        session_id: `folded-${sanitizeRef(args.ref)}`,
        started: startedIso,
        ended: startedIso,
        track: 'sidecar' as const,
      },
      body,
      SessionFrontmatterSchema,
    );

    await appendTriagedLog('fold', args.ref, `into:${args.into}`);

    return { ref: args.ref, into: args.into, session_file: sessionFile };
  },
});

function buildSessionFilename(iso: string, ref: string): string {
  // iso: 2026-05-12T15:23:45.000Z → 2026-05-12-1523
  const stamp = iso.slice(0, 16).replace('T', '-').replace(':', '');
  return `${stamp}-folded-${sanitizeRef(ref)}.md`;
}

function sanitizeRef(ref: string): string {
  return (
    ref
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'ref'
  );
}
