/**
 * Daemon entrypoint, composed over `@titan-design/daemon` (AW-a).
 *
 * The package owns binding the socket, splicing `/mcp`, watching the active
 * root, the pid file, and signal shutdown. What stays here is the one thing it
 * has no business knowing: the session-index watcher, which must start only
 * after `/health` is answerable and be closed — awaited — before the socket
 * does, because a refresh may be mid-transaction.
 */
import { DaemonAlreadyRunningError, startDaemon } from '@titan-design/daemon';
import type { Hono } from 'hono';
import { DaemonError } from '../errors.js';
import type { SchedulerStatus } from '../session-index/scheduler.js';
import { getActiveRoot, getStateRoot } from '../utils/paths.js';
import { handleDashboard } from './dashboard-routes.js';
import { DAEMON_VERSION, type HealthIndexState } from './health.js';
import { resolveDaemonPort } from './lifecycle.js';
import { getLogger } from './logger.js';
import { mcpOptions } from './mcp.js';
import { startSessionIndexWatch, type SessionIndexWatcher } from './session-index-watch.js';

export interface RunDaemonOptions {
  port?: number;
}

function resolvePort(options: RunDaemonOptions): number {
  if (typeof options.port === 'number' && Number.isFinite(options.port)) return options.port;
  return resolveDaemonPort();
}

/** Project the scheduler's snapshot onto the shape `/health` publishes. */
function toHealthIndexState(status: SchedulerStatus | undefined): HealthIndexState | null {
  if (!status) return null;
  return {
    indexing: status.running,
    pending: status.pending,
    lastRunAt: status.last?.startedAt ?? null,
    lastDurationMs: status.last?.durationMs ?? null,
    consecutiveErrors: status.consecutiveErrors,
  };
}

export async function runDaemon(options: RunDaemonOptions = {}): Promise<void> {
  const log = getLogger();
  // Read through a closure: the watcher only starts once the port is bound.
  let indexWatch: SessionIndexWatcher | null = null;

  const handle = await startDaemon({
    ...mcpOptions(),
    stateDir: getStateRoot(),
    port: resolvePort(options),
    watchRoot: getActiveRoot(),
    version: DAEMON_VERSION,
    logger: log,
    health: () => ({ index: toHealthIndexState(indexWatch?.status()) }),
    mountRoutes: (app: Hono) => {
      app.get('/ui', (c) => handleDashboard(c));
      app.get('/ui/*', (c) => handleDashboard(c));
    },
  }).catch((err: unknown) => {
    // The package's error carries the pid and port; active-work's callers
    // catch DaemonError, so translate rather than leak a second error type.
    if (err instanceof DaemonAlreadyRunningError) throw new DaemonError(err.message);
    throw err;
  });

  indexWatch = startSessionIndexWatch(log);

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info({ signal }, 'shutting down');
      void (async () => {
        try {
          // Awaited before the socket closes: a refresh may be mid-transaction
          // and must commit before the process exits.
          await indexWatch?.close();
        } catch (err) {
          log.error({ err }, 'error closing session index watcher');
        }
        try {
          await handle.close();
        } catch (err) {
          log.error({ err }, 'error closing daemon');
        }
        log.info('stopped');
        resolve();
      })();
    };

    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
}
