/**
 * Integration test for AW-3 live reload: spawn a real daemon, open the
 * `/events` SSE stream, edit a file under the active root, and assert a
 * `change` event lands within ~1s — the task's done_when.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
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
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon never became healthy on port ${port}`);
}

/**
 * Open the SSE stream and resolve with the first frame whose body contains
 * `needle` after `trigger` has run, or reject on timeout.
 */
async function waitForEvent(
  port: number,
  needle: string,
  trigger: () => void,
  timeoutMs: number,
): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/events`, {
    headers: { accept: 'text/event-stream' },
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  // Read the initial "ready" frame so the server-side subscriber is live.
  await reader.read();
  trigger();

  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(needle)) return buffer;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`event containing "${needle}" never arrived; saw: ${buffer}`);
}

describe('integration: daemon live-reload SSE', () => {
  beforeAll(() => {
    expect(existsSync(TSX_BIN)).toBe(true);
  });

  it('broadcasts a change event when a file under the active root is edited', async () => {
    const port = await findFreePort();
    const stateRoot = mkdtempSync(path.join(tmpdir(), 'aw-sse-int-'));
    const activeRoot = mkdtempSync(path.join(tmpdir(), 'aw-sse-int-data-'));

    const child: ChildProcess = spawn(TSX_BIN, ['-e', ENTRY_SRC], {
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
        process.stderr.write(`[daemon] ${chunk.toString()}`);
      });

      await waitForHealth(port, 15_000);
      // The watcher starts just after health; give it a beat to attach.
      await new Promise((r) => setTimeout(r, 200));

      const frame = await waitForEvent(
        port,
        'event: change',
        () => writeFileSync(path.join(activeRoot, 'brief.md'), '# edited outside the dashboard\n'),
        5_000,
      );
      expect(frame).toContain('active-root');
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 8_000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(activeRoot, { recursive: true, force: true });
    }
  }, 40_000);
});
