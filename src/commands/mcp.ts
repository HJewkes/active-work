import { z } from 'zod';
import { defineCommand } from '../registry/index.js';
import { runMcpStdio } from '../server/mcp.js';

/**
 * `aw mcp serve [--stdio]` — start an MCP server.
 *
 * Wave 3 ships stdio mode only. Wave 4 will add `--http` (with the hono
 * daemon) and lifecycle sub-commands (`mcp.stop`, `mcp.status`, ...).
 */

const ArgsSchema = z.object({
  stdio: z.boolean().optional(),
});

type Args = z.infer<typeof ArgsSchema>;

const ResultSchema = z.object({
  exited: z.boolean(),
});

type Result = z.infer<typeof ResultSchema>;

export default defineCommand<Args, Result>({
  name: 'mcp.serve',
  description:
    'Start the MCP server. With --stdio, speaks JSON-RPC over stdio so Claude Code can connect via `claude mcp add`.',
  args: ArgsSchema,
  result: ResultSchema,
  cli: {
    options: {
      stdio: {
        long: '--stdio',
        description: 'Run in stdio mode (default; only mode in v0).',
      },
    },
  },
  async run(args) {
    // Default to stdio when no mode flag is supplied.
    const useStdio = args.stdio ?? true;
    if (useStdio) {
      await runMcpStdio();
    }
    return { exited: true };
  },
});
