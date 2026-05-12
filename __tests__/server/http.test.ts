import { describe, it, expect } from 'vitest';
import { buildHttpApp } from '../../src/server/http.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const TEST_PORT = 17400;

function get(app: ReturnType<typeof buildHttpApp>, p: string): Promise<Response> {
  return app.fetch(new Request(`http://127.0.0.1:${TEST_PORT}${p}`));
}

function post(
  app: ReturnType<typeof buildHttpApp>,
  p: string,
  body: unknown,
): Promise<Response> {
  return app.fetch(
    new Request(`http://127.0.0.1:${TEST_PORT}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('GET /health', () => {
  it('returns ok + version + pid + uptime + port', async () => {
    const app = buildHttpApp({ port: TEST_PORT });
    const res = await get(app, '/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(typeof body.pid).toBe('number');
    expect(typeof body.uptime_ms).toBe('number');
    expect(body.port).toBe(TEST_PORT);
  });
});

describe('GET /version', () => {
  it('returns the daemon version string', async () => {
    const app = buildHttpApp({ port: TEST_PORT });
    const res = await get(app, '/version');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });
});

describe('POST /rpc/:name', () => {
  it('runs the registered command and returns a JSON envelope', async () => {
    await withTempActiveRoot(async () => {
      const app = buildHttpApp({ port: TEST_PORT });
      const res = await post(app, '/rpc/list', {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; data?: { sections: unknown } };
      expect(body.ok).toBe(true);
      expect(body.data?.sections).toBeDefined();
    });
  });

  it('returns 404 for an unknown command', async () => {
    const app = buildHttpApp({ port: TEST_PORT });
    const res = await post(app, '/rpc/does-not-exist', {});
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/Unknown command/);
  });

  it('returns 400 with a clear error envelope on invalid args', async () => {
    await withTempActiveRoot(async () => {
      const app = buildHttpApp({ port: TEST_PORT });
      // task.add requires slug + title.
      const res = await post(app, '/rpc/task.add', {});
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/Invalid arguments/i);
    });
  });
});

describe('GET /ui/*', () => {
  it('returns HTML; placeholder when the dashboard bundle is missing', async () => {
    const app = buildHttpApp({ port: TEST_PORT });
    const res = await get(app, '/ui/anything');
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toMatch(/text\/html/);
    const text = await res.text();
    // Either the placeholder, or the real built dashboard. Both are HTML.
    if (text.includes('Dashboard not built yet')) {
      expect(text).toContain('pnpm build:dashboard');
    } else {
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
