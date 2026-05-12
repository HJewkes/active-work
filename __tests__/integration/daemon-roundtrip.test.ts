/**
 * Integration: spawn the live HTTP daemon as a child process on a random
 * free port, exercise /health, /version, /rpc/*, /mcp, /ui, then SIGTERM
 * and confirm the PID file is cleaned up.
 *
 * Each request runs against a real network socket — this test catches
 * regressions in the hono routing, JSON envelope, MCP-over-HTTP transport,
 * and the dashboard placeholder route that the unit suite can't see.
 */
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const DAEMON_PATH = path
  .join(REPO_ROOT, 'src', 'server', 'daemon.ts')
  .replaceAll('\\', '\\\\');
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

interface JsonOk<T> {
  ok: true;
  data: T;
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; envelope: JsonOk<T> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const envelope = (await res.json()) as JsonOk<T>;
  return { status: res.status, envelope };
}

interface ParsedMcpJson {
  result?: { tools?: unknown[]; content?: Array<{ type: string; text: string }> };
  error?: unknown;
}

function parseMcpResponse(raw: string): ParsedMcpJson {
  if (raw.startsWith('{')) return JSON.parse(raw) as ParsedMcpJson;
  // Server-Sent Events form: data:<json>\n
  const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`unexpected MCP response shape: ${raw.slice(0, 200)}`);
  return JSON.parse(dataLine.slice('data:'.length).trim()) as ParsedMcpJson;
}

describe('integration: live daemon roundtrip on a random port', () => {
  it('serves health, version, rpc, mcp, ui; cleans pid file on SIGTERM', async () => {
    const port = await findFreePort();
    const stateRoot = mkdtempSync(path.join(tmpdir(), 'aw-rt-state-'));
    const activeRoot = mkdtempSync(path.join(tmpdir(), 'aw-rt-active-'));

    const child = spawn(TSX_BIN, ['-e', ENTRY_SRC], {
      env: {
        ...process.env,
        AW_PORT: String(port),
        XDG_STATE_HOME: stateRoot,
        XDG_DATA_HOME: stateRoot,
        XDG_CONFIG_HOME: stateRoot,
        XDG_CACHE_HOME: stateRoot,
        ACTIVE_ROOT: activeRoot,
        HOME: stateRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      child.stderr?.on('data', (chunk: Buffer) => {
        // Surface daemon logs only when something fails.
        process.stderr.write(`[daemon] ${chunk.toString()}`);
      });

      await waitForHealth(port, 15_000);

      // /health
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as { ok: boolean; port: number; version: string };
      expect(health.ok).toBe(true);
      expect(health.port).toBe(port);
      expect(typeof health.version).toBe('string');

      // /version
      const versionRes = await fetch(`http://127.0.0.1:${port}/version`);
      expect(versionRes.status).toBe(200);
      const version = (await versionRes.json()) as { version: string };
      expect(typeof version.version).toBe('string');

      // /rpc/new — create an initiative on disk via the live HTTP path.
      const newRes = await postJson<{ slug: string; dir: string }>(
        `http://127.0.0.1:${port}/rpc/new`,
        { slug: 'rt-init', title: 'Roundtrip Init', ship_target: '2026-Q4' },
      );
      expect(newRes.status).toBe(200);
      expect(newRes.envelope.ok).toBe(true);
      expect(newRes.envelope.data.slug).toBe('rt-init');
      expect(existsSync(path.join(activeRoot, 'rt-init', 'brief.md'))).toBe(true);

      // /rpc/task.add — task file written.
      const taskRes = await postJson<{ id: string }>(
        `http://127.0.0.1:${port}/rpc/task.add`,
        { slug: 'rt-init', title: 'first task' },
      );
      expect(taskRes.envelope.ok).toBe(true);
      expect(taskRes.envelope.data.id).toBe('RI-1');
      expect(
        existsSync(path.join(activeRoot, 'rt-init', 'tasks', 'RI-1.yml')),
      ).toBe(true);

      // /rpc/list — initiative shows up.
      const listRes = await postJson<{
        sections: Array<{ heading: string; items: Array<{ slug: string }> }>;
      }>(`http://127.0.0.1:${port}/rpc/list`, {});
      const focused = listRes.envelope.data.sections.find((s) => s.heading === 'Focused');
      expect(focused?.items.map((i) => i.slug)).toContain('rt-init');

      // /mcp — tools/list.
      const toolsRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
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
      expect(toolsRes.ok).toBe(true);
      const toolsParsed = parseMcpResponse(await toolsRes.text());
      expect(Array.isArray(toolsParsed.result?.tools)).toBe(true);
      expect(toolsParsed.result!.tools!.length).toBeGreaterThanOrEqual(36);

      // /mcp — tools/call active__list.
      const callRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'active__list', arguments: {} },
        }),
      });
      expect(callRes.ok).toBe(true);
      const callParsed = parseMcpResponse(await callRes.text());
      const content = callParsed.result?.content;
      expect(Array.isArray(content)).toBe(true);
      const inner = JSON.parse(content![0]!.text) as {
        ok: boolean;
        data: { sections: unknown };
      };
      expect(inner.ok).toBe(true);
      expect(inner.data.sections).toBeDefined();

      // /ui/ — placeholder or built dashboard.
      const uiRes = await fetch(`http://127.0.0.1:${port}/ui/`);
      expect(uiRes.status).toBe(200);
      const html = await uiRes.text();
      // Accept either the placeholder or a built index.
      expect(html.toLowerCase()).toMatch(/<html|<!doctype/);
    } finally {
      child.kill('SIGTERM');
      await waitForExit(child, 10_000).catch(() => {
        child.kill('SIGKILL');
      });
      // Poll briefly for PID file removal — handler runs after server close.
      const pidGone = await pollUntilGone(() => findDaemonPidFile(stateRoot), 5_000);
      expect(pidGone).toBe(true);
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(activeRoot, { recursive: true, force: true });
    }
  }, 45_000);
});

async function pollUntilGone(
  probe: () => string | null,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe() === null) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return probe() === null;
}
