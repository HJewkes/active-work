import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeCommand } from '@titan-design/registry';
import '../../src/commands/index.js';
import taskAdd from '../../src/commands/task-add.js';
import taskApply from '../../src/commands/task-apply.js';
import taskDone from '../../src/commands/task-done.js';
import taskEdit from '../../src/commands/task-edit.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const NOW = new Date('2026-07-01T15:42:07.123Z');
const LATER = new Date('2026-07-02T09:05:00.000Z');

const REGISTRY = {
  kind: ['epic'],
  status: [
    { id: 'open', closed: false, dispatchable: true },
    { id: 'in-progress', closed: false, dispatchable: false },
    { id: 'done', closed: true, dispatchable: false },
    { id: 'wont-do', closed: true, dispatchable: false },
    { id: 'icebox', closed: false, dispatchable: false },
  ],
  cos: ['standard'],
  area: [],
};

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json', cwd: activeRoot };
}

function taskFile(root: string, id: string): string {
  return path.join(root, SLUG, 'tasks', `${id}.yml`);
}

async function readTask(root: string, id: string): Promise<Record<string, unknown>> {
  return YAML.parse(await fs.readFile(taskFile(root, id), 'utf8'));
}

async function writeRegistry(root: string): Promise<void> {
  const file = path.join(root, 'titan-platform', 'categories.yml');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, YAML.stringify(REGISTRY));
}

function setStatus(root: string, value: string) {
  return taskEdit.run({ slug: SLUG, id: 'SI-1', field: 'status', value }, ctx(root));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('task timestamps', () => {
  it('task add writes created as a full UTC timestamp', async () => {
    await withTempActiveRoot(async (root) => {
      const created = await taskAdd.run({ slug: SLUG, title: 'Timed task' }, ctx(root));

      expect(created.created).toBe(NOW.toISOString());
      expect((await readTask(root, created.id)).created).toBe(NOW.toISOString());
    });
  });

  it('task done writes done_at as a full UTC timestamp', async () => {
    await withTempActiveRoot(async (root) => {
      const done = await taskDone.run({ slug: SLUG, id: 'SI-1' }, ctx(root));

      expect(done.done_at).toBe(NOW.toISOString());
      expect((await readTask(root, 'SI-1')).done_at).toBe(NOW.toISOString());
    });
  });

  it('task edit to status done writes done_at as a full UTC timestamp', async () => {
    await withTempActiveRoot(async (root) => {
      const done = await setStatus(root, 'done');

      expect(done.done_at).toBe(NOW.toISOString());
    });
  });

  it('a task apply done op writes done_at as a full UTC timestamp', async () => {
    await withTempActiveRoot(async (root) => {
      const plan = path.join(root, 'plan.jsonl');
      await fs.writeFile(plan, JSON.stringify({ slug: SLUG, id: 'SI-1', ops: [{ done: true }] }));

      await invokeCommand(taskApply, { plan }, ctx(root));

      expect((await readTask(root, 'SI-1')).done_at).toBe(NOW.toISOString());
    });
  });

  it('the first move to in-progress writes started_at, and a later one keeps it', async () => {
    await withTempActiveRoot(async (root) => {
      await writeRegistry(root);

      const started = await setStatus(root, 'in-progress');
      vi.setSystemTime(LATER);
      await setStatus(root, 'open');
      const restarted = await setStatus(root, 'in-progress');

      expect(started.started_at).toBe(NOW.toISOString());
      expect(restarted.started_at).toBe(NOW.toISOString());
      expect((await readTask(root, 'SI-1')).started_at).toBe(NOW.toISOString());
    });
  });

  it('an edit to a status other than in-progress writes no started_at', async () => {
    await withTempActiveRoot(async (root) => {
      const done = await setStatus(root, 'done');

      expect(done.started_at).toBeUndefined();
    });
  });

  it('a date-only task still loads and edits without rewriting its dates', async () => {
    await withTempActiveRoot(async (root) => {
      const before = await readTask(root, 'SI-2');

      const edited = await taskEdit.run(
        { slug: SLUG, id: 'SI-2', field: 'title', value: 'Renamed' },
        ctx(root),
      );

      expect(edited.created).toBe(before.created);
      expect(edited.done_at).toBe(before.done_at);
    });
  });
});
