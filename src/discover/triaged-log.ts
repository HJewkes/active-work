import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../utils/fs-atomic.js';
import { getActiveRoot } from '../utils/paths.js';
import { nowIso } from '../utils/today.js';

/**
 * Append a single triage decision to `<activeRoot>/.triaged.log`.
 *
 * Format: `<nowIso()>\t<action>\t<ref>\t<extra>` — one line per decision.
 * The orchestrator reads this file to suppress already-decided refs from
 * future discoveries.
 */
export async function appendTriagedLog(
  action: 'fold' | 'drop' | 'track',
  ref: string,
  extra: string,
): Promise<void> {
  const root = getActiveRoot();
  await fs.mkdir(root, { recursive: true });
  const logPath = path.join(root, '.triaged.log');
  let existing = '';
  try {
    existing = await fs.readFile(logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const line = `${nowIso()}\t${action}\t${ref}\t${extra}\n`;
  await atomicWrite(logPath, existing + line);
}
