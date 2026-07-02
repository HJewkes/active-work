/**
 * HTTP daemon: hono app that exposes the command registry, MCP-over-HTTP,
 * health/version endpoints, and a static dashboard placeholder.
 *
 * The app is intentionally pure — it constructs and returns a `Hono`
 * instance without binding a port; `daemon.ts` handles the lifecycle.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { registry, successEnvelope, errorEnvelope } from '../registry/index.js';
import type { CommandContext } from '../registry/index.js';
import '../commands/index.js'; // populate the registry on import
import { formatError, EXIT } from '../errors.js';
import { getActiveRoot } from '../utils/paths.js';
import { buildHealthPayload, DAEMON_VERSION } from './health.js';
import { handleDashboard } from './dashboard-routes.js';
import type { EventHub } from './events.js';

export interface BuildHttpAppOptions {
  port: number;
  /**
   * Optional event hub for live-reload SSE. When present, `/events` streams
   * change notifications; when absent (e.g. unit tests), `/events` still
   * connects but only emits heartbeats.
   */
  hub?: EventHub;
}

/** Interval between SSE keep-alive comments (ms). */
const HEARTBEAT_MS = 25_000;

export function buildHttpApp(options: BuildHttpAppOptions): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json(buildHealthPayload(options.port)));

  app.get('/version', (c) => c.json({ version: DAEMON_VERSION }));

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'ready', data: 'connected' });
      const unsubscribe = options.hub?.subscribe((message) =>
        stream.writeSSE(message),
      );
      stream.onAbort(() => unsubscribe?.());
      // Hold the connection open, emitting periodic heartbeats so proxies and
      // dead-peer detection keep the stream healthy until the client aborts.
      while (!stream.aborted) {
        await stream.sleep(HEARTBEAT_MS);
        if (stream.aborted) break;
        await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
      }
      unsubscribe?.();
    }),
  );

  app.post('/rpc/:name', async (c) => {
    const name = c.req.param('name');
    const cmd = registry.get(name);
    if (!cmd) {
      return c.json(errorEnvelope(`Unknown command: ${name}`, EXIT.USAGE), 404);
    }

    let rawArgs: unknown = {};
    const contentLength = c.req.header('content-length');
    if (contentLength && contentLength !== '0') {
      try {
        rawArgs = await c.req.json();
      } catch {
        return c.json(errorEnvelope('Invalid JSON body', EXIT.USAGE), 400);
      }
    }

    let parsed: unknown;
    try {
      parsed = cmd.args.parse(rawArgs ?? {});
    } catch (err) {
      const f = formatError(err);
      const message =
        err instanceof z.ZodError ? `Invalid arguments: ${f.message}` : f.message;
      return c.json(errorEnvelope(message, EXIT.DATAERR), 400);
    }

    const ctx: CommandContext = {
      activeRoot: getActiveRoot(),
      warnings: [],
      format: 'json',
    };

    try {
      const result = await cmd.run(parsed, ctx);
      return c.json(successEnvelope(result, ctx.warnings));
    } catch (err) {
      const f = formatError(err);
      return c.json(errorEnvelope(f.message, f.code), 500);
    }
  });

  app.get('/ui', (c) => handleDashboard(c));
  app.get('/ui/*', (c) => handleDashboard(c));

  return app;
}
