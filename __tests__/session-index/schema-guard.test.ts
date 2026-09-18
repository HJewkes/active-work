/**
 * store-sqlite 0.3.0's forward-schema guard, as active-work applies it: a graph
 * stamped by a newer active-work is refused on every open path with a message
 * naming both versions, and is left exactly as it was found.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../../src/doctor.js';
import { ConfigError } from '../../src/errors.js';
import {
  defaultGraphPath,
  openGraph,
  openGraphReadOnly,
  SCHEMA_VERSION,
} from '../../src/session-index/graph.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const FUTURE_VERSION = SCHEMA_VERSION + 1;

/** Build a current graph, then record one migration past what this build knows. */
function stampFutureGraph(dbPath: string): void {
  openGraph(dbPath).db.close();
  const db = new Database(dbPath);
  db.prepare('INSERT INTO _migration (version, name, applied_at) VALUES (?, ?, ?)').run(
    FUTURE_VERSION,
    'from-a-newer-active-work',
    new Date().toISOString(),
  );
  db.close();
}

function storedVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare('SELECT MAX(version) AS v FROM _migration').get() as { v: number }).v;
  } finally {
    db.close();
  }
}

function expectUpgradeMessage(err: unknown, dbPath: string): void {
  expect(err).toBeInstanceOf(ConfigError);
  const message = (err as Error).message;
  expect(message).toContain(dbPath);
  expect(message).toContain(`records schema version ${FUTURE_VERSION}`);
  expect(message).toContain(`knows only up to ${SCHEMA_VERSION}`);
  expect(message).toContain('Upgrade active-work');
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the open to throw');
}

describe('opening a graph written by a newer active-work', () => {
  it('refuses the migrating open with an upgrade message, before any migration runs', async () => {
    await withEmptyActiveRoot(async (root) => {
      const dbPath = path.join(root, 'graph.sqlite3');
      stampFutureGraph(dbPath);

      expectUpgradeMessage(
        thrownBy(() => openGraph(dbPath)),
        dbPath,
      );
      expect(storedVersion(dbPath)).toBe(FUTURE_VERSION);
    });
  });

  it('refuses the read-only diagnostic open the same way', async () => {
    await withEmptyActiveRoot(async (root) => {
      const dbPath = path.join(root, 'graph.sqlite3');
      stampFutureGraph(dbPath);

      expectUpgradeMessage(
        thrownBy(() => openGraphReadOnly(dbPath)),
        dbPath,
      );
    });
  });

  it('still opens a graph at the version this build knows', async () => {
    await withEmptyActiveRoot(async (root) => {
      const dbPath = path.join(root, 'graph.sqlite3');
      openGraph(dbPath).db.close();

      const graph = openGraph(dbPath);
      graph.db.close();
      openGraphReadOnly(dbPath).close();

      expect(storedVersion(dbPath)).toBe(SCHEMA_VERSION);
    });
  });

  it('makes doctor fail the workspace-index check rather than call it unbuilt', async () => {
    await withEmptyActiveRoot(async (root) => {
      stampFutureGraph(defaultGraphPath());

      // Stubbed so the test never reaches a daemon or supervisor on this machine.
      const report = await runDoctor({
        activeRoot: root,
        probeDaemon: async () => ({ running: false, healthy: false }),
        supervisorActive: async () => null,
      });

      const check = report.checks.find((c) => c.name === 'workspace-index');
      expect(check?.status).toBe('fail');
      expect(check?.detail).toContain('Upgrade active-work');
    });
  });
});
