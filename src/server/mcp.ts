/**
 * active-work's binding of `@titan-design/daemon`'s MCP surface (AW-a).
 *
 * The package parameterises every entry point on `McpServerOptions` so one
 * client can host several registries; active-work hosts exactly one, under the
 * `active__` prefix (`task.add` -> `active__task__add`). Those names are public
 * contract — they appear in consumers' configs and in `~/.claude.json` — so the
 * prefix and the handshake identity are pinned here and asserted by
 * `__tests__/server/mcp-tool-names.test.ts`.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  attachHandlers as pkgAttachHandlers,
  createMcpServer as pkgCreateMcpServer,
  invokeTool as pkgInvokeTool,
  listTools as pkgListTools,
  runMcpStdio as pkgRunMcpStdio,
  type McpServerOptions,
  type ToolCallOutcome,
} from '@titan-design/daemon';
import {
  commandNameToToolName as pkgCommandNameToToolName,
  commandToTool as pkgCommandToTool,
  toolNameToCommandName as pkgToolNameToCommandName,
  type McpToolDescriptor,
} from '@titan-design/registry';
import { registry, type AnyCommand, type CommandContext } from '../registry/index.js';
import '../commands/index.js'; // populates registry on import
import { formatError } from '../errors.js';
import { getActiveRoot } from '../utils/paths.js';
import { DAEMON_VERSION } from './health.js';

const TOOL_NAME_PREFIX = 'active__';
const NAMING = { prefix: TOOL_NAME_PREFIX } as const;

export type McpTool = McpToolDescriptor;
export type { ToolCallOutcome };

/** The MCP identity and registry binding every entry point below shares. */
export function mcpOptions(): McpServerOptions<CommandContext> {
  return {
    registry,
    createContext: () => ({ activeRoot: getActiveRoot(), warnings: [], format: 'json' }),
    formatError,
    toolPrefix: TOOL_NAME_PREFIX,
    name: '@hjewkes/active-work',
    version: DAEMON_VERSION,
  };
}

/** Convert a command name (e.g. `task.add`) to a tool name (`active__task__add`). */
export function commandNameToToolName(commandName: string): string {
  return pkgCommandNameToToolName(commandName, NAMING);
}

export function toolNameToCommandName(toolName: string): string | null {
  return pkgToolNameToCommandName(toolName, NAMING);
}

export function commandToTool(cmd: AnyCommand): McpTool {
  return pkgCommandToTool(cmd, NAMING);
}

export function listTools(): McpTool[] {
  return pkgListTools(mcpOptions());
}

export async function invokeTool(toolName: string, rawArgs: unknown): Promise<ToolCallOutcome> {
  return pkgInvokeTool(mcpOptions(), toolName, rawArgs);
}

/** Wire MCP request handlers onto a server instance. Exposed for testing. */
export function attachHandlers(server: Server): void {
  pkgAttachHandlers(server, mcpOptions());
}

export function createMcpServer(): Server {
  return pkgCreateMcpServer(mcpOptions());
}

/** Run the MCP server over stdio. Resolves when the transport closes. */
export async function runMcpStdio(): Promise<void> {
  await pkgRunMcpStdio(mcpOptions());
}
