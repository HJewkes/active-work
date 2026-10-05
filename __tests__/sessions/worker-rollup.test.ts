import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import sessionList from '../../src/commands/session-list.js';
import { assembleBootstrap } from '../../src/bootstrap/prompt.js';
import {
  buildWorkerRollup,
  renderWorkerRollup,
  spawnerOf,
  type RollupInput,
} from '../../src/sessions/worker-rollup.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import type { CommandContext } from '../../src/registry/index.js';

const SLUG = 'sample-initiative';

const stub = (agent: string, minute: number): RollupInput => ({
  sessionId: `${agent}-s${minute}`,
  ended: `2026-06-01T10:${String(minute).padStart(2, '0')}:00Z`,
  track: 'adhoc',
  body: `Peer "${agent}" (profile worker) (spawned via agent-chat) exited with code 0.\n`,
});

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

async function seed(activeRoot: string, input: RollupInput, index: number): Promise<void> {
  const file = path.join(
    activeRoot,
    SLUG,
    'sessions',
    `2026-06-01-10${index}-${input.sessionId}.md`,
  );
  const front = [
    '---',
    `session_id: ${input.sessionId}`,
    `started: '${input.ended}'`,
    `ended: '${input.ended}'`,
    `track: ${input.track}`,
    'no_loops: true',
    '---',
    '',
  ].join('\n');
  await fs.writeFile(file, front + input.body);
}

describe('spawnerOf', () => {
  it('takes the seat prefix before the first dash', () => {
    expect(spawnerOf('zz-fix-parser')).toBe('zz');
  });

  it('leaves a name with no prefix unattributed', () => {
    expect(spawnerOf('plain')).toBe('unattributed');
    expect(spawnerOf(null)).toBe('unattributed');
  });
});

describe('buildWorkerRollup', () => {
  it('counts stubs as no report, per spawner, busiest first', () => {
    const rollup = buildWorkerRollup([
      stub('aa-one', 1),
      stub('bb-one', 2),
      stub('bb-two', 3),
      stub('loose', 4),
    ]);
    expect(rollup.spawners.map((s) => [s.spawner, s.total, s.no_report])).toEqual([
      ['bb', 2, 2],
      ['aa', 1, 1],
      ['unattributed', 1, 1],
    ]);
  });

  it('ignores records that are not worker stubs', () => {
    const note: RollupInput = { ...stub('aa-one', 1), body: 'Hand-written wrap.\n' };
    expect(buildWorkerRollup([note]).spawners).toEqual([]);
  });
});

describe('renderWorkerRollup', () => {
  it('prints one roll-up line per spawner then caps the exceptions', () => {
    const inputs = Array.from({ length: 10 }, (_, i) => stub('aa-w', i));
    const lines = renderWorkerRollup(buildWorkerRollup(inputs), 5);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('- aa: 10 workers — 0 merged, 0 open PR, 10 no report, 0 concerns');
    expect(lines[4]).toBe('  - +7 more exceptions');
  });
});

describe('session.list worker kind', () => {
  it('filters by --kind and returns the roll-up as data', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      await seed(activeRoot, stub('aa-one', 1), 1);
      await seed(activeRoot, stub('aa-two', 2), 2);
      await seed(activeRoot, { ...stub('x', 3), body: 'Human wrap.\n' }, 3);

      const workers = await sessionList.run({ slug: SLUG, kind: 'worker' }, ctx(activeRoot));
      expect(workers.sessions.map((s) => s.kind)).toEqual(['worker', 'worker']);
      expect(workers.workers.spawners).toHaveLength(1);
      expect(workers.workers.spawners[0]).toMatchObject({ spawner: 'aa', total: 2, no_report: 2 });

      const adhoc = await sessionList.run({ slug: SLUG, kind: 'adhoc' }, ctx(activeRoot));
      expect(adhoc.sessions).toHaveLength(1);
      expect(adhoc.workers.spawners).toEqual([]);
    });
  });
});

describe('bootstrap worker roll-up', () => {
  it('renders 15 worker records in at most 5 lines', async () => {
    await withTempActiveRoot(async (activeRoot) => {
      const agents = ['aa-', 'bb-', 'cc-'];
      for (let i = 0; i < 15; i++) {
        await seed(activeRoot, stub(`${agents[i % 3]}w${i}`, 10 + i), 10 + i);
      }
      const { prompt } = await assembleBootstrap({
        activeRoot,
        slug: SLUG,
        now: new Date('2026-06-02T00:00:00Z'),
        includeLiveStatus: false,
      });
      const section = prompt.split('# Parallel sessions since then\n')[1] ?? '';
      const lines = section.split('\n\n')[0]!.split('\n');
      expect(lines.length).toBeLessThanOrEqual(5);
      expect(lines[0]).toContain('5 workers');
    });
  });
});
