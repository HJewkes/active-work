/**
 * TP-105 regression: the daemon refuses what a cross-origin page can send and
 * still serves active-work's own clients. Runs the real daemon in-process on
 * an ephemeral loopback port, never 7400.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { DaemonHandle } from '@titan-design/daemon';
import { fetchInitiatives } from '../../src/dashboard/utils/api.js';
import { startActiveWorkDaemon } from '../../src/server/daemon.js';
import { probeHealth } from '../../src/server/lifecycle.js';
import { getStateRoot } from '../../src/utils/paths.js';
import { assertSafeToRemove, withEmptyActiveRoot } from '../setup/test-helpers.js';

interface RawResponse {
  status: number;
  body: string;
}

const LIST_TOOLS = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
const MCP_ACCEPT = 'application/json, text/event-stream';
const ROUTES = [
  { route: '/rpc/list', body: '{}' },
  { route: '/mcp', body: LIST_TOOLS },
] as const;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Raw `node:http`, because fetch will not let a caller forge `Host`. */
function post(
  port: number,
  route: string,
  headers: Record<string, string>,
  body: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: route, method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function get(port: number, route: string, host: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: route, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: '' }));
    });
    req.on('error', reject);
    req.end();
  });
}

function jsonHeaders(route: string, extra: Record<string, string> = {}): Record<string, string> {
  const accept = route === '/mcp' ? { accept: MCP_ACCEPT } : {};
  return { 'content-type': 'application/json', ...accept, ...extra };
}

/** The browser half of the dashboard: relative URLs resolve against the page, and a POST carries its Origin. */
function browserAt(origin: string): typeof fetch {
  return ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('origin', origin);
    return originalFetch(new URL(String(input), origin), { ...init, headers });
  }) as typeof fetch;
}

async function withDaemon(fn: (port: number) => Promise<void>): Promise<void> {
  await withEmptyActiveRoot(async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'aw-test-'));
    // The logger writes under the state root; it must be the sandboxed home, never the operator's.
    expect(getStateRoot().startsWith(os.tmpdir())).toBe(true);
    let handle: DaemonHandle | null = null;
    try {
      handle = await startActiveWorkDaemon({ port: 0, stateDir });
      expect(handle.port).not.toBe(7400);
      await fn(handle.port);
    } finally {
      await handle?.close();
      assertSafeToRemove(stateDir);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

describe.each(ROUTES)('daemon request guards on $route', ({ route, body }) => {
  it('refuses a text/plain body with 415', async () => {
    await withDaemon(async (port) => {
      const res = await post(
        port,
        route,
        jsonHeaders(route, { 'content-type': 'text/plain' }),
        body,
      );

      expect(res.status).toBe(415);
      expect(JSON.parse(res.body)).toMatchObject({
        ok: false,
        error: 'Content-Type must be application/json',
      });
    });
  });

  it('refuses a foreign Origin with 403', async () => {
    await withDaemon(async (port) => {
      const res = await post(
        port,
        route,
        jsonHeaders(route, { origin: 'http://evil.example' }),
        body,
      );

      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({
        ok: false,
        error: 'Origin is not one this daemon answers to',
      });
    });
  });

  it('refuses a rebinding Host with 403', async () => {
    await withDaemon(async (port) => {
      const res = await post(port, route, jsonHeaders(route, { host: 'evil.example' }), body);

      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({
        ok: false,
        error: 'Host header is not one this daemon answers to',
      });
    });
  });

  it('serves a JSON POST with no Origin, as the CLI, agent-chat and Claude Code send it', async () => {
    await withDaemon(async (port) => {
      const res = await post(port, route, jsonHeaders(route), body);

      expect(res.status).toBe(200);
    });
  });
});

describe('daemon request guards for active-work clients', () => {
  it('answers every loopback Host spelling with the bound port', async () => {
    await withDaemon(async (port) => {
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
        expect((await get(port, '/health', host)).status, host).toBe(200);
      }
    });
  });

  it('serves the dashboard rpc client from its own origin', async () => {
    await withDaemon(async (port) => {
      globalThis.fetch = browserAt(`http://127.0.0.1:${port}`);

      const result = await fetchInitiatives();

      expect(result).toMatchObject({ sections: expect.any(Array) });
    });
  });

  it('answers the CLI health probe that mcp status, doctor and miner status use', async () => {
    await withDaemon(async (port) => {
      const health = await probeHealth(port);

      expect(health).toMatchObject({ port, pid: process.pid });
    });
  });
});
