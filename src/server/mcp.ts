/**
 * MCP stdio server.
 *
 * Exposes every Command registered in `src/registry/` as an MCP tool, with
 * inputSchema derived from the command's zod args. Tool name is the
 * hierarchical command name with dots replaced by double underscores and
 * an `active__` prefix (e.g. `task.add` -> `active__task__add`).
 *
 * Wave 3 ships the stdio transport only; Wave 4 will wrap the same handlers
 * in an HTTP transport hosted by the daemon.
 */

import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  registry,
  successEnvelope,
  errorEnvelope,
  type AnyCommand,
  type CommandContext,
  type JsonEnvelope,
} from '../registry/index.js';
import '../commands/index.js'; // populates registry on import
import { formatError } from '../errors.js';
import { getActiveRoot } from '../utils/paths.js';

const TOOL_NAME_PREFIX = 'active__';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Convert a command name (e.g. `task.add`) to a tool name (`active__task__add`). */
export function commandNameToToolName(commandName: string): string {
  return TOOL_NAME_PREFIX + commandName.replaceAll('.', '__');
}

/** Convert a tool name back to a command name. Returns null if it isn't ours. */
export function toolNameToCommandName(toolName: string): string | null {
  if (!toolName.startsWith(TOOL_NAME_PREFIX)) return null;
  return toolName.slice(TOOL_NAME_PREFIX.length).replaceAll('__', '.');
}

/**
 * Strip top-level `$schema` / `definitions` keys that the MCP client doesn't
 * need (and some clients reject when present at the root of inputSchema).
 */
function stripJsonSchemaCruft(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, definitions: _defs, ...rest } = schema;
  void _schema;
  void _defs;
  return rest;
}

/**
 * Build an MCP tool descriptor from a command. Uses Zod 4's native
 * `z.toJSONSchema` (the spec-mentioned `zod-to-json-schema` package only
 * supports Zod v3 schemas; this repo is on Zod 4).
 */
export function commandToTool(cmd: AnyCommand): McpTool {
  // z.toJSONSchema accepts any zod schema; cast away the registry's generic.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = z.toJSONSchema(cmd.args as any) as Record<string, unknown>;
  const inputSchema = stripJsonSchemaCruft(raw);
  // MCP requires inputSchema.type === 'object'. Every registered command's
  // args is a z.object(...), so this is satisfied; assert defensively.
  if (inputSchema.type !== 'object') {
    inputSchema.type = 'object';
  }
  return {
    name: commandNameToToolName(cmd.name),
    description: cmd.description,
    inputSchema,
  };
}

/** List every registered command as an MCP tool. */
export function listTools(): McpTool[] {
  return Array.from(registry.values()).map(commandToTool);
}

interface ToolCallOutcome {
  isError: boolean;
  envelope: JsonEnvelope<unknown>;
}

/**
 * Resolve a tool name to its command, parse args, and invoke `run()`.
 * Always returns an envelope; errors are wrapped, never thrown.
 */
export async function invokeTool(toolName: string, rawArgs: unknown): Promise<ToolCallOutcome> {
  const commandName = toolNameToCommandName(toolName);
  const cmd = commandName ? registry.get(commandName) : undefined;
  if (!cmd) {
    const err = formatError(new Error(`Unknown tool: ${toolName}`));
    return { isError: true, envelope: errorEnvelope(err.message, err.code) };
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = cmd.args.parse(rawArgs ?? {});
  } catch (err) {
    const f = formatError(err);
    const message = err instanceof z.ZodError ? `Invalid arguments: ${f.message}` : f.message;
    return { isError: true, envelope: errorEnvelope(message, f.code) };
  }

  const ctx: CommandContext = {
    activeRoot: getActiveRoot(),
    warnings: [],
    format: 'json',
  };

  try {
    const result = await cmd.run(parsedArgs, ctx);
    return { isError: false, envelope: successEnvelope(result, ctx.warnings) };
  } catch (err) {
    const f = formatError(err);
    return { isError: true, envelope: errorEnvelope(f.message, f.code) };
  }
}

/** Wire MCP request handlers onto a server instance. Exposed for testing. */
export function attachHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, () => {
    return { tools: listTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const { isError, envelope } = await invokeTool(name, args);
    return {
      isError,
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
    };
  });
}

/** Construct a fully-wired MCP server, sans transport. */
export function createMcpServer(): Server {
  const server = new Server(
    {
      name: '@hjewkes/active-work',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );
  attachHandlers(server);
  return server;
}

/**
 * Run the MCP server over stdio. Resolves when the transport closes
 * (i.e. when the client disconnects).
 */
export async function runMcpStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const original = transport.onclose;
    transport.onclose = () => {
      try {
        original?.();
      } finally {
        resolve();
      }
    };
  });
}
