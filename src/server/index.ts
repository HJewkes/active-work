export {
  runMcpStdio,
  createMcpServer,
  attachHandlers,
  commandToTool,
  commandNameToToolName,
  toolNameToCommandName,
  listTools,
  invokeTool,
} from './mcp.js';
export type { McpTool } from './mcp.js';

export { runDaemon } from './daemon.js';
export { buildHttpApp } from './http.js';
export { buildHealthPayload, DAEMON_VERSION, startedAt } from './health.js';
export {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
} from './lifecycle.js';
export type { DaemonMeta, PidFileContents } from './lifecycle.js';
export { getLogger } from './logger.js';
