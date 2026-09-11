/**
 * active-work's binding of `@titan-design/daemon`'s hono app (AW-a).
 *
 * The package owns `/health`, `/version`, `/events` and `POST /rpc/:name`.
 * This file supplies the three things it deliberately does not know: how to
 * build a `CommandContext`, that `/health` carries an `index` payload, and
 * that `/ui` serves a dashboard.
 *
 * The `index` field name is load-bearing. `miner status` probes `/health`
 * cross-process and reads `health.index` rather than opening a second
 * endpoint, so the package's `health()` extension seam has to reproduce that
 * key exactly.
 */
import type { EventHub } from '@titan-design/daemon';
import { buildHttpApp as pkgBuildHttpApp } from '@titan-design/daemon';
import type { Hono } from 'hono';
import { registry, type CommandContext } from '../registry/index.js';
import '../commands/index.js'; // populate the registry on import
import { formatError } from '../errors.js';
import { getActiveRoot } from '../utils/paths.js';
import { handleDashboard } from './dashboard-routes.js';
import { startedAt, type HealthIndexState } from './health.js';
import { BUILD_VERSION } from '../version.js';

export interface BuildHttpAppOptions {
  port: number;
  /**
   * Optional event hub for live-reload SSE. When present, `/events` streams
   * change notifications; when absent (e.g. unit tests), `/events` still
   * connects but only emits heartbeats.
   */
  hub?: EventHub;
  /**
   * Session-index snapshot, read per request. A getter rather than a value
   * because the index watcher starts after the app is built.
   */
  indexState?: () => HealthIndexState | null;
  /**
   * Whether startup has finished (PID file written). Until it has, `/health`
   * answers 503: the port binds before the PID file exists, so a caller that
   * treated a bound port as "ready" could look the daemon up and find nothing.
   */
  ready?: () => boolean;
}

export function buildHttpApp(options: BuildHttpAppOptions): Hono {
  return pkgBuildHttpApp<CommandContext>({
    registry,
    createContext: () => ({ activeRoot: getActiveRoot(), warnings: [], format: 'json' }),
    formatError,
    version: BUILD_VERSION,
    startedAt,
    port: () => options.port,
    hub: options.hub,
    ready: options.ready,
    health: () => ({ index: options.indexState?.() ?? null }),
    mountRoutes: (app) => {
      app.get('/ui', (c) => handleDashboard(c));
      app.get('/ui/*', (c) => handleDashboard(c));
    },
  });
}
