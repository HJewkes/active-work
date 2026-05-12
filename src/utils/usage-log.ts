import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getStateRoot } from './paths.js';

/**
 * Single line in `$XDG_STATE_HOME/active-work/usage.jsonl`.
 *
 * The log is fire-and-forget telemetry written by the CLI dispatcher for
 * later self-reflection. Failures to write must never break the user's
 * command, so `appendUsage` swallows all errors.
 */
export interface UsageRecord {
  ts: string; // ISO 8601
  command: string; // registry name
  args?: Record<string, unknown>;
  duration_ms?: number;
  success: boolean;
  exit_code: number;
}

/** Resolve the on-disk path of the usage log. */
export function usageLogPath(): string {
  return path.join(getStateRoot(), 'usage.jsonl');
}

/**
 * Append a single JSON-encoded record + newline to the usage log.
 *
 * Silent on any error: telemetry must never fail a user-facing command.
 */
export async function appendUsage(rec: UsageRecord): Promise<void> {
  try {
    const file = usageLogPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // Intentionally silent.
  }
}
