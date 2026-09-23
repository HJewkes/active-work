import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  allSessionIds,
  refreshCorpus,
  rollupSessions,
  syncPrices,
  type DiscoveredTranscript,
} from '@titan-design/session-graph';
import {
  costReport,
  LIST_PRICE_CAVEAT,
  PRICE_TABLE,
  PRICE_TABLE_VERSION,
} from '@titan-design/session-analytics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import minerCost from '../../src/commands/miner-cost.js';
import type { CommandContext } from '../../src/registry/types.js';
import { defaultGraphPath, openGraph, openGraphReadOnly } from '../../src/session-index/graph.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

/**
 * `miner cost` over a hand-built graph: three sessions spanning every
 * dimension `costReport` buckets by — human adhoc, human coordinator (a
 * channel-message wake), and an agent-spawned worker — with a gap and a
 * large cache-creation request in one session to trigger a cold rebuild.
 */

const SESSION_ADHOC = 'sess-adhoc';
const SESSION_COORD = 'sess-coord';
const SESSION_WORKER = 'sess-worker';

function repo(root: string, name: string): string {
  const dir = path.join(root, 'projects', name);
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  writeFileSync(
    path.join(dir, '.git', 'config'),
    `[remote "origin"]\n\turl = git@github.com:acme/${name}.git\n`,
    'utf8',
  );
  return dir;
}

function line(
  sessionId: string,
  cwd: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return { sessionId, cwd, gitBranch: 'main', ...fields };
}

function userPrompt(sessionId: string, cwd: string, uuid: string, ts: string, text: string) {
  return line(sessionId, cwd, {
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: text },
  });
}

function channelPrompt(sessionId: string, cwd: string, ts: string) {
  return line(sessionId, cwd, {
    type: 'user',
    timestamp: ts,
    message: {
      role: 'user',
      content:
        '<channel source="plugin:agent-chat:agent-chat" from="peer-1" msg_id="m1">go</channel>',
    },
  });
}

function assistant(
  sessionId: string,
  cwd: string,
  ts: string,
  requestId: string,
  model: string,
  usage: Record<string, number>,
) {
  return line(sessionId, cwd, {
    type: 'assistant',
    timestamp: ts,
    requestId,
    message: {
      id: `msg-${requestId}`,
      role: 'assistant',
      model,
      usage,
      content: [{ type: 'text', text: 'ok' }],
    },
  });
}

let dir: string;
let alpha: string;
let beta: string;

/** Builds the fixture graph at `defaultGraphPath()` inside the active `dir`. */
async function seedGraph(dir: string): Promise<void> {
  alpha = repo(dir, 'alpha');
  beta = repo(dir, 'beta');

  const adhocLines = [
    userPrompt(SESSION_ADHOC, alpha, 'p1', '2026-09-01T00:00:00Z', 'first prompt'),
    assistant(SESSION_ADHOC, alpha, '2026-09-01T00:00:05Z', 'req-a1', 'claude-sonnet-5', {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }),
    userPrompt(SESSION_ADHOC, alpha, 'p2', '2026-09-01T02:00:00Z', 'second prompt after a gap'),
    // Cold rebuild: cache_read (1000) < 0.2 * context (63000), cache_creation >= 20000.
    assistant(SESSION_ADHOC, alpha, '2026-09-01T02:00:05Z', 'req-a2', 'claude-sonnet-5', {
      input_tokens: 2000,
      output_tokens: 200,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 60000,
    }),
  ];
  const coordLines = [
    channelPrompt(SESSION_COORD, beta, '2026-09-01T00:00:00Z'),
    assistant(SESSION_COORD, beta, '2026-09-01T00:00:05Z', 'req-c1', 'claude-sonnet-5', {
      input_tokens: 500,
      output_tokens: 100,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 100,
    }),
  ];
  const workerLines = [
    userPrompt(SESSION_WORKER, alpha, 'p1', '2026-09-01T00:00:00Z', 'brief'),
    assistant(SESSION_WORKER, alpha, '2026-09-01T00:00:05Z', 'req-w1', 'claude-opus-5', {
      input_tokens: 1000,
      output_tokens: 300,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 200,
    }),
  ];

  const graph = openGraph(defaultGraphPath());
  function write(name: string, lines: unknown[]): DiscoveredTranscript {
    const absolutePath = path.join(dir, `${name}.jsonl`);
    writeFileSync(absolutePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    return {
      projectDir: name,
      absolutePath,
      displayPath: `~/demo/${name}.jsonl`,
      subagentId: null,
      account: null,
    };
  }
  await refreshCorpus(
    graph,
    [write('adhoc', adhocLines), write('coord', coordLines), write('worker', workerLines)],
    {
      resolveOrigins: (sessionIds) => ({
        origins: Object.fromEntries(
          sessionIds
            .filter((id) => id === SESSION_WORKER)
            .map((id) => [
              id,
              {
                originSystem: 'agent-chat',
                depth: 1,
                profile: 'implementer',
                originKind: 'spawned',
              },
            ]),
        ),
      }),
    },
  );
  rollupSessions(graph, allSessionIds(graph));
  syncPrices(graph, PRICE_TABLE, { tableVersion: PRICE_TABLE_VERSION });
  graph.db.close();
}

function ctx(format: 'human' | 'json' = 'json'): CommandContext {
  return { activeRoot: '', warnings: [], format };
}

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('miner cost', () => {
  it('prints weekly spend by class, role, initiative, context band, wake cause and cold-rebuild cost', async () => {
    await withEmptyActiveRoot(async (root) => {
      dir = root;
      await seedGraph(dir);

      const result = await minerCost.run({}, ctx('human'));

      expect(result.byClass.map((b) => b.key).sort()).toEqual([
        'agent_spawned',
        'human_interactive',
      ]);
      expect(result.byRole.map((b) => b.key).sort()).toEqual([
        'adhoc',
        'coordinator',
        'worker:implementer',
      ]);
      expect(result.byInitiative.map((b) => b.key).sort()).toEqual(['repo:alpha', 'repo:beta']);
      expect(result.byContextBand.map((b) => b.key).sort()).toEqual(['50-100k', '<50k']);
      expect(result.byWakeCause.map((b) => b.key).sort()).toEqual(['channel_message', 'human']);
      expect(result.coldRebuild).toMatchObject({ requests: 1 });
      expect(result.coldRebuild.byGapBandAndCause).toEqual([
        { wakeCause: 'human_typed', gapBand: '>60m', requests: 1, costUsd: expect.any(Number) },
      ]);

      const text = vi
        .mocked(process.stderr.write)
        .mock.calls.map((call) => call[0])
        .join('');
      expect(text).toContain('By class');
      expect(text).toContain('By role');
      expect(text).toContain('By initiative');
      expect(text).toContain('By context band');
      expect(text).toContain('By wake cause');
      expect(text).toContain('Cold rebuild');
    });
  });

  it('--json emits the costReport object unchanged', async () => {
    await withEmptyActiveRoot(async (root) => {
      dir = root;
      await seedGraph(dir);
      const db = openGraphReadOnly(defaultGraphPath());
      const expected = costReport(db);
      db.close();

      const result = await minerCost.run({}, ctx('json'));

      expect(result).toEqual(expected);
      expect(process.stderr.write).not.toHaveBeenCalled();
    });
  });

  it('--days, --since, --until and --top are honoured', async () => {
    await withEmptyActiveRoot(async (root) => {
      dir = root;
      await seedGraph(dir);

      const excludingAll = await minerCost.run({ days: 1 }, ctx());
      expect(excludingAll.totals.requests).toBe(0);

      const includingAll = await minerCost.run({ days: 4000 }, ctx());
      expect(includingAll.totals.requests).toBe(4);

      const before = await minerCost.run({ until: '2026-09-01T01:00:00Z' }, ctx());
      expect(before.totals.requests).toBe(3);

      const after = await minerCost.run({ since: '2026-09-01T01:00:00Z' }, ctx());
      expect(after.totals.requests).toBe(1);

      const topOne = await minerCost.run({ top: 1 }, ctx());
      expect(topOne.topSessions).toHaveLength(1);
    });
  });

  it('opens the graph read-only', async () => {
    await withEmptyActiveRoot(async (root) => {
      dir = root;
      await seedGraph(dir);
      chmodSync(defaultGraphPath(), 0o444);

      await expect(minerCost.run({}, ctx())).resolves.toMatchObject({ totals: { requests: 4 } });

      chmodSync(defaultGraphPath(), 0o644);
    });
  });

  it('prints the coverage line and the list-price caveat', async () => {
    await withEmptyActiveRoot(async (root) => {
      dir = root;
      await seedGraph(dir);

      await minerCost.run({}, ctx('human'));

      const text = vi
        .mocked(process.stderr.write)
        .mock.calls.map((call) => call[0])
        .join('');
      expect(text).toContain('3 transcripts indexed');
      expect(text).toContain(LIST_PRICE_CAVEAT);
    });
  });
});
