/**
 * Daemon entrypoint.
 *
 * `runDaemon` binds the hono app to 127.0.0.1:<port>, writes a PID
 * file, and stays running until SIGTERM/SIGINT. It does not call
 * `process.exit` — the caller decides how the process terminates.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serve, type ServerType } from '@hono/node-server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DaemonError } from '../errors.js';
import { buildHttpApp } from './http.js';
import { DAEMON_VERSION } from './health.js';
import { getLogger } from './logger.js';
import { createMcpServer } from './mcp.js';
import {
  isProcessAlive,
  readPidFile,
  removePidFile,
  writePidFile,
} from './lifecycle.js';

export interface RunDaemonOptions {
  port?: number;
}

const DEFAULT_PORT = 7400;
const HOSTNAME = '127.0.0.1';

function resolvePort(options: RunDaemonOptions): number {
  if (typeof options.port === 'number' && Number.isFinite(options.port)) {
    return options.port;
  }
  const envPort = process.env.AW_PORT;
  if (envPort) {
    const n = Number.parseInt(envPort, 10);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_PORT;
}

async function assertNotAlreadyRunning(): Promise<void> {
  const existing = await readPidFile();
  if (existing && isProcessAlive(existing.pid)) {
    throw new DaemonError(
      `Daemon already running (pid ${existing.pid}, port ${existing.meta.port})`,
    );
  }
  if (existing) {
    // Stale PID file — clean it up so writePidFile lands cleanly.
    await removePidFile();
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handle a /mcp request by spinning up a fresh MCP server + transport
 * and letting the transport write directly to the Node response. We
 * bypass hono for this route because the transport assumes ownership
 * of the response object.
 */
async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let body: unknown;
  if (req.method === 'POST') {
    try {
      body = await readJsonBody(req);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
      return;
    }
  }
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function listenOn(app: ReturnType<typeof buildHttpApp>, port: number): Promise<ServerType> {
  return new Promise((resolve) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: HOSTNAME,
        port,
      },
      () => resolve(server),
    );
    // Replace the request handler: route /mcp to the MCP transport
    // directly, falling through to hono for everything else.
    const honoHandler = server.listeners('request')[0] as
      | ((req: IncomingMessage, res: ServerResponse) => void)
      | undefined;
    server.removeAllListeners('request');
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '';
      if (url === '/mcp' || url.startsWith('/mcp?') || url.startsWith('/mcp/')) {
        void handleMcpRequest(req, res).catch((err) => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(String(err));
          } else {
            res.destroy();
          }
        });
        return;
      }
      if (honoHandler) honoHandler(req, res);
    });
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function runDaemon(options: RunDaemonOptions = {}): Promise<void> {
  const log = getLogger();
  await assertNotAlreadyRunning();

  const port = resolvePort(options);
  const app = buildHttpApp({ port });
  const server = await listenOn(app, port);
  const started = new Date().toISOString();

  await writePidFile(process.pid, {
    port,
    version: DAEMON_VERSION,
    started,
  });
  log.info({ pid: process.pid, port, started }, 'daemon started');

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ signal }, 'shutting down');
      void (async () => {
        try {
          await closeServer(server);
        } catch (err) {
          log.error({ err }, 'error closing server');
        }
        try {
          await removePidFile();
        } catch (err) {
          log.error({ err }, 'error removing pid file');
        }
        log.info('stopped');
        resolve();
      })();
    };

    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}
