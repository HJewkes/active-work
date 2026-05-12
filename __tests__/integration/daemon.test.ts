/**
 * Integration test: spawn a real daemon process via tsx, drive HTTP +
 * MCP-over-HTTP against it, then SIGTERM and check the PID file is gone.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const DAEMON_PATH = path.join(REPO_ROOT, 'src', 'server', 'daemon.ts').replaceAll('\\', '\\\\');
const ENTRY_SRC = `import('${DAEMON_PATH}').then((m) => m.runDaemon({ port: Number(process.env.AW_PORT) })).catch((e) => { console.error(e); process.exit(1); });`;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.createServer();
    sock.listen(0, '127.0.0.1', () => {
      const addr = sock.address();
      if (typeof addr === 'object' && addr && 'port' in addr) {
        const { port } = addr;
        sock.close(() => resolve(port));
      } else {
        sock.close();
        reject(new Error('Unexpected address shape'));
      }
    });
    sock.on('error', reject);
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon never became healthy on port ${port}: ${String(lastErr)}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('daemon did not exit in time')), timeoutMs),
    ),
  ]);
}

describe('integration: daemon over HTTP', () => {
  beforeAll(() => {
    expect(existsSync(TSX_BIN)).toBe(true);
  });

  it('serves /health, /rpc/list, and /mcp; cleans up the PID file on shutdown', async () => {
    const port = await findFreePort();
    const stateRoot = mkdtempSync(path.join(tmpdir(), 'aw-daemon-int-'));
    const activeRoot = mkdtempSync(path.join(tmpdir(), 'aw-daemon-int-data-'));

    const child = spawn(TSX_BIN, ['-e', ENTRY_SRC], {
      env: {
        ...process.env,
        AW_PORT: String(port),
        XDG_STATE_HOME: stateRoot,
        XDG_DATA_HOME: stateRoot,
        XDG_CONFIG_HOME: stateRoot,
        XDG_CACHE_HOME: stateRoot,
        ACTIVE_ROOT: activeRoot,
        HOME: stateRoot, // for macOS env-paths fallback
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      child.stderr?.on('data', (chunk: Buffer) => {
        // Surface daemon logs if the test fails.
        process.stderr.write(`[daemon] ${chunk.toString()}`);
      });

      await waitForHealth(port, 15_000);

      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as { ok: boolean; port: number };
      expect(health.ok).toBe(true);
      expect(health.port).toBe(port);

      const rpcRes = await fetch(`http://127.0.0.1:${port}/rpc/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(rpcRes.status).toBe(200);
      const rpc = (await rpcRes.json()) as { ok: boolean; data?: { sections: unknown } };
      expect(rpc.ok).toBe(true);
      expect(rpc.data?.sections).toBeDefined();

      // MCP-over-HTTP: tools/list
      const mcpRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
      expect(mcpRes.ok).toBe(true);
      // Response may be JSON or an SSE stream; handle both.
      const text = await mcpRes.text();
      let parsed: { result?: { tools?: unknown[] } };
      if (text.startsWith('{')) {
        parsed = JSON.parse(text) as typeof parsed;
      } else {
        const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
        expect(dataLine).toBeDefined();
        parsed = JSON.parse(dataLine!.slice('data:'.length).trim()) as typeof parsed;
      }
      expect(Array.isArray(parsed.result?.tools)).toBe(true);
      expect(parsed.result!.tools!.length).toBeGreaterThanOrEqual(35);
    } finally {
      child.kill('SIGTERM');
      await waitForExit(child, 10_000).catch(() => {
        child.kill('SIGKILL');
      });
      // The PID file should be cleaned up by the daemon's signal handler.
      // env-paths on Linux: <XDG_STATE_HOME>/active-work/daemon.pid
      // on macOS: ~/Library/Logs/active-work/daemon.pid (using HOME override)
      // Just assert no daemon.pid file remains under any state location.
      const lingering = findDaemonPidFile(stateRoot);
      expect(lingering).toBeNull();
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(activeRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

function findDaemonPidFile(root: string): string | null {
  if (!existsSync(root)) return null;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === 'daemon.pid') return full;
    }
  }
  return null;
}
