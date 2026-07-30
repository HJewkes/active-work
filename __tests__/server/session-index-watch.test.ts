import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startSessionIndexWatch } from '../../src/server/session-index-watch.js';

const log = { info: vi.fn(), warn: vi.fn() };

let home: string;

beforeEach(() => {
  vi.restoreAllMocks();
  log.info.mockClear();
  log.warn.mockClear();
  home = mkdtempSync(path.join(os.tmpdir(), 'aw-index-watch-'));
  process.env.HOME = home;
});

afterEach(() => {
  delete process.env.AW_INDEX_WATCH;
  rmSync(home, { recursive: true, force: true });
});

describe('startSessionIndexWatch', () => {
  it('returns null and logs rather than throwing when the index cannot be opened', async () => {
    const db = await import('../../src/miner/session-index/db.js');
    vi.spyOn(db, 'openSessionIndex').mockImplementation(() => {
      throw new Error('better-sqlite3 ABI mismatch');
    });

    expect(startSessionIndexWatch(log)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('transcript indexing disabled'),
    );
  });

  it('can be switched off entirely with AW_INDEX_WATCH=0', () => {
    process.env.AW_INDEX_WATCH = '0';

    expect(startSessionIndexWatch(log)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('starts a non-blocking initial refresh and closes cleanly', async () => {
    writeFileSync(path.join(home, 'ignored.txt'), 'x', 'utf8');

    const watcher = startSessionIndexWatch(log);

    expect(watcher).not.toBeNull();
    // Construction returns immediately; the refresh is un-awaited so the
    // daemon can bind its port before a cold corpus finishes indexing.
    expect(watcher!.status()).toMatchObject({ running: true });
    await watcher!.close();
    expect(watcher!.status()).toMatchObject({ running: false, pending: false });
  });
});
