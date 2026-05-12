import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_LIMITS, type LintFinding, type LintLimits } from './types.js';

/**
 * Count meaningful body lines, treating trailing whitespace-only lines as
 * absent. This keeps a single trailing newline from inflating the count.
 */
function countBodyLines(body: string): number {
  const lines = body.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  return lines.length;
}

/**
 * Read `handoff.md` from `initiativeDir` and return any lint findings.
 *
 * Returns `[]` when the file does not exist — every other tool already
 * complains about that, lint is purely advisory. The single warning emitted
 * here is the body-length cap.
 */
export async function lintHandoff(
  slug: string,
  initiativeDir: string,
  limits: LintLimits = DEFAULT_LIMITS,
): Promise<LintFinding[]> {
  const filePath = path.join(initiativeDir, 'handoff.md');
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }

  const bodyLines = countBodyLines(raw);
  if (bodyLines <= limits.handoffMaxBodyLines) return [];

  return [
    {
      level: 'warn',
      slug,
      file: 'handoff.md',
      message: `body is ${bodyLines} lines (> ${limits.handoffMaxBodyLines}). Move resolved/archival content to a purpose-named file under sources/ and trim the handoff.`,
    },
  ];
}
