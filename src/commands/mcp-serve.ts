import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { runMcpStdio } from '../server/mcp.js';
import { runDaemon } from '../server/daemon.js';

/**
 * `active-work mcp serve` — start the MCP server.
 *
 * - `--stdio`: speak JSON-RPC over stdio (for `claude mcp add`).
 * - `--detach`: fork a child running `active-work mcp serve` in the background.
 * - default: run the HTTP daemon in the foreground on `--port` (default 7400).
 */

const ArgsSchema = z.object({
  stdio: z.boolean().optional(),
  detach: z.boolean().optional(),
  port: z.number().int().positive().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  mode: z.enum(['stdio', 'http', 'detached']),
  pid: z.number().optional(),
  port: z.number().optional(),
});

type Result = z.infer<typeof ResultSchema>;

function detachedSpawn(port: number | undefined): { pid: number; port: number } {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error('Cannot determine CLI entrypoint for detach');
  }
  const args = ['mcp', 'serve'];
  if (port !== undefined) {
    args.push('--port', String(port));
  }
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return { pid: child.pid ?? -1, port: port ?? 7400 };
}

export default defineCommand<Args, Result>({
  name: 'mcp.serve',
  description:
    'Start the MCP server. --stdio for stdio mode; --detach to fork the HTTP daemon; otherwise runs the HTTP daemon in the foreground.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      stdio: {
        long: '--stdio',
        description: 'Run in stdio mode for Claude Code `claude mcp add`.',
      },
      detach: {
        long: '--detach',
        description: 'Spawn the HTTP daemon in the background and return.',
      },
      port: {
        long: '--port',
        description: 'TCP port for the HTTP daemon (default 7400).',
      },
    },
  },
  async run(args) {
    if (args.stdio) {
      await runMcpStdio();
      return { mode: 'stdio' };
    }
    if (args.detach) {
      const { pid, port } = detachedSpawn(args.port);
      return { mode: 'detached', pid, port };
    }
    await runDaemon({ port: args.port });
    return { mode: 'http', port: args.port };
  },
});
