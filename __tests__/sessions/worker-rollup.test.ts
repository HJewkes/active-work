import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import sessionList from '../../src/commands/session-list.js';
import { assembleBootstrap } from '../../src/bootstrap/prompt.js';
import {
  buildWorkerRollup,
  isWorkerRecord,
  renderWorkerRollup,
  sessionKindOf,
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

function factsRecord(
  agent: string,
  minute: number,
  opts: { report?: string; pr?: boolean; lastAction?: string },
): RollupInput {
  const facts = {
    agent,
    profile: 'implementer',
    spawner: 'sample-coord',
    report: opts.report
      ? { messageId: `m-${agent}`, kind: 'status' as const, text: opts.report }
      : null,
    pr: opts.pr ? { repo: 'example-org/sample-repo', number: minute } : null,
    exit: { code: 0, signal: null, inferred: false },
  };
  const noReport = opts.report === undefined;
  return {
    sessionId: `${agent}-s${minute}`,
    ended: `2026-06-01T10:${String(minute).padStart(2, '0')}:00Z`,
    track: 'adhoc',
    body: opts.report ?? `Peer "${agent}" sent no report (exit code 0).`,
    kind: 'worker',
    worker: noReport
      ? { facts, outcome: 'exited-no-report', last_action: opts.lastAction }
      : { facts },
  };
}

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

  it('merges numbered seats of one prefix', () => {
    expect(spawnerOf('vw385')).toBe('vw');
    expect(spawnerOf('vw467-fix')).toBe('vw');
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

  it('attributes a facts record to its spawner and counts it by its report', () => {
    const rollup = buildWorkerRollup([
      factsRecord('w1', 1, { report: 'Status: DONE\nSX-1 merged.', pr: true }),
      factsRecord('w2', 2, { report: 'Status: DONE\nPR open for review.', pr: true }),
      factsRecord('w3', 3, { report: 'Status: BLOCKED\nNo access.' }),
      factsRecord('w4', 4, { lastAction: 'Bash: pnpm test' }),
    ]);

    expect(rollup.spawners).toHaveLength(1);
    expect(rollup.spawners[0]).toMatchObject({
      spawner: 'sample-coord',
      total: 4,
      merged: 1,
      open_pr: 1,
      concerns: 1,
      no_report: 1,
    });
    expect(rollup.spawners[0]?.exceptions.map((e) => [e.agent, e.outcome, e.summary])).toEqual([
      ['w4', 'no_report', 'Bash: pnpm test'],
      ['w3', 'concerns', 'Status: BLOCKED'],
    ]);
  });

  it('lets an explicit kind win over the stub inference', () => {
    const record = factsRecord('zz-not-a-prefix', 1, { report: 'Status: DONE' });
    expect(isWorkerRecord(record)).toBe(true);
    expect(sessionKindOf(record)).toBe('worker');
    expect(buildWorkerRollup([record]).spawners[0]?.spawner).toBe('sample-coord');
  });
});

describe('renderWorkerRollup', () => {
  it('prints one roll-up line per spawner then caps the exceptions', () => {
    const inputs = Array.from({ length: 10 }, (_, i) => stub('aa-w', i));
    const lines = renderWorkerRollup(buildWorkerRollup(inputs), 5);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('- aa: 10 workers — 0 merged, 0 open PR, 10 no report, 0 concerns');
  });

  it('puts each exception directly under its own spawner', () => {
    const inputs = [stub('aa-w', 1), stub('bb-w', 2), stub('bb-x', 3)];
    const lines = renderWorkerRollup(buildWorkerRollup(inputs), 5);
    expect(lines.map((l) => l.replace(/ — .*|2026-06-01 /g, '').trim())).toEqual([
      '- bb: 2 workers',
      '- bb-x',
      '- bb-w',
      '- aa: 1 worker',
      '- aa-w',
    ]);
  });

  it('bounds each spawner exception list and counts the rest', () => {
    const inputs = Array.from({ length: 20 }, (_, i) => stub('aa-w', i));
    const [spawner] = buildWorkerRollup(inputs).spawners;
    expect(spawner?.exceptions).toHaveLength(3);
    expect(spawner?.exceptions_omitted).toBe(17);
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
