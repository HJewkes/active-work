import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { getStateRoot } from '../utils/paths.js';

/**
 * `active-work mcp logs` — return the tail of `daemon.log`.
 *
 * No `--follow` support in v0; callers that need streaming can `tail -f`
 * the file directly.
 */

const ArgsSchema = z.object({
  lines: z.number().int().positive().optional(),
});
type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  lines: z.array(z.string()),
});
type Result = z.infer<typeof ResultSchema>;

const DEFAULT_LINES = 50;

export default defineCommand<Args, Result>({
  name: 'mcp.logs',
  description: 'Return the last N lines of the daemon log (default 50).',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      lines: {
        long: '--lines',
        description: 'Number of trailing lines to return (default 50).',
      },
    },
  },
  async run(args) {
    const n = args.lines ?? DEFAULT_LINES;
    const logPath = path.join(getStateRoot(), 'daemon.log');
    let content: string;
    try {
      content = await fs.readFile(logPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { lines: [] };
      }
      throw err;
    }
    const allLines = content.split(/\r?\n/);
    // Drop trailing empty line(s) from the final newline.
    while (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    return { lines: allLines.slice(-n) };
  },
});
