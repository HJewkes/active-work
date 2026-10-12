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
  costPerOutcomeSchema,
  LIST_PRICE_CAVEAT,
  PRICE_TABLE,
  PRICE_TABLE_VERSION,
} from '@titan-design/session-analytics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import minerOutcomes from '../../src/commands/miner-outcomes.js';
import type { CommandContext } from '../../src/registry/types.js';
import { defaultGraphPath, openGraph } from '../../src/session-index/graph.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

/**
 * `miner outcomes` over a hand-built graph holding one spawned worker named
 * `impl-1`, plus a synthetic seat log that dispatches and merges it. The
 * worker makes one request at 05:00Z and one at 07:30Z, so a window starting
 * at 06:00Z (`00:00-06:00`) keeps only the second.
 */

const SESSION_WORKER = 'sess-impl-1';
const EARLY_REQUEST_TOKENS = 1_000_000;
const LATE_REQUEST_TOKENS = 1_000;

function assistant(cwd: string, ts: string, requestId: string, inputTokens: number) {
  return {
    sessionId: SESSION_WORKER,
    cwd,
    gitBranch: 'main',
    type: 'assistant',
    timestamp: ts,
    requestId,
    message: {
      id: `msg-${requestId}`,
      role: 'assistant',
      model: 'claude-opus-5',
      usage: {
        input_tokens: inputTokens,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: 'text', text: 'ok' }],
    },
  };
}

async function seedGraph(root: string): Promise<void> {
  const cwd = path.join(root, 'projects', 'alpha');
  mkdirSync(cwd, { recursive: true });
  const lines = [
    {
      sessionId: SESSION_WORKER,
      cwd,
      gitBranch: 'main',
      type: 'user',
      uuid: 'p1',
      timestamp: '2026-09-01T05:00:00Z',
      message: { role: 'user', content: 'brief' },
    },
    assistant(cwd, '2026-09-01T05:00:05Z', 'req-early', EARLY_REQUEST_TOKENS),
    assistant(cwd, '2026-09-01T07:30:00Z', 'req-late', LATE_REQUEST_TOKENS),
  ];
  const absolutePath = path.join(root, 'worker.jsonl');
  writeFileSync(absolutePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const transcript: DiscoveredTranscript = {
    projectDir: 'worker',
    absolutePath,
    displayPath: '~/demo/worker.jsonl',
    subagentId: null,
    account: null,
  };

  const graph = openGraph(defaultGraphPath());
  await refreshCorpus(graph, [transcript], {
    resolveOrigins: (sessionIds) => ({
      origins: Object.fromEntries(
        sessionIds.map((id) => [
          id,
          {
            originSystem: 'agent-chat',
            agentName: 'impl-1',
            depth: 1,
            profile: 'implementer',
            originKind: 'spawned',
          },
        ]),
      ),
    }),
  });
  rollupSessions(graph, allSessionIds(graph));
  syncPrices(graph, PRICE_TABLE, { tableVersion: PRICE_TABLE_VERSION });
  graph.db.close();
}

function seedLogs(root: string): string {
  const logs = path.join(root, 'logs');
  mkdirSync(path.join(logs, 'seat-a'), { recursive: true });
  const row = (ts: string, outcome: string) =>
    JSON.stringify({ ts, agent: 'impl-1', task: 'T-1', kind: 'feature', outcome });
  const lines = [
    row('2026-09-01T07:00:00Z', 'dispatched'),
    '{not json',
    row('2026-09-01T08:00:00Z', 'merged'),
  ];
  writeFileSync(path.join(logs, 'seat-a', 'dispatch.jsonl'), lines.join('\n') + '\n', 'utf8');
  return logs;
}

function ctx(format: 'human' | 'json' = 'json'): CommandContext {
  return { activeRoot: '', warnings: [], format };
}

function stderrText(): string {
  return vi
    .mocked(process.stderr.write)
    .mock.calls.map((call) => call[0])
    .join('');
}

beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('miner outcomes', () => {
  it('prints the per-seat table, the list-price caveat and the skipped line', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedGraph(root);
      const logs = seedLogs(root);

      await minerOutcomes.run({ logs }, ctx('human'));

      const text = stderrText();
      expect(text).toContain('seat-a');
      expect(text).toContain(LIST_PRICE_CAVEAT);
      expect(text).toContain('Skipped: 1 unparseable lines, 0 rows without an agent.');
    });
  });

  it('json format returns a costPerOutcome report with one merge and the skipped counts', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedGraph(root);
      const logs = seedLogs(root);

      const result = await minerOutcomes.run({ logs }, ctx('json'));

      expect(() => costPerOutcomeSchema.parse(result)).not.toThrow();
      expect(result.bySeat).toHaveLength(1);
      expect(result.bySeat[0]).toMatchObject({ key: 'seat-a', assignments: 1, merged: 1 });
      expect(result.bySeat[0]!.costUsd).toBeGreaterThan(0);
      expect(result.joinSource.agentName).toBe(1);
      expect(result.skipped).toEqual({ badLines: 1, noAgent: 0 });
      expect(process.stderr.write).not.toHaveBeenCalled();
    });
  });

  it('normalises an offset --since to UTC before comparing against request timestamps', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedGraph(root);
      const logs = seedLogs(root);
      const all = await minerOutcomes.run({ logs }, ctx());

      const result = await minerOutcomes.run({ logs, since: '2026-09-01T00:00:00-06:00' }, ctx());

      expect(result.window).toEqual({ since: '2026-09-01T06:00:00.000Z', until: null });
      expect(result.bySeat[0]).toMatchObject({ merged: 1 });
      expect(result.totals.costUsd).toBeGreaterThan(0);
      expect(result.totals.costUsd * 100).toBeLessThan(all.totals.costUsd);
    });
  });

  it('rejects an unparseable --until', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedGraph(root);

      await expect(
        minerOutcomes.run({ logs: seedLogs(root), until: 'not-a-date' }, ctx()),
      ).rejects.toThrow('--until');
    });
  });

  it('opens the graph read-only', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seedGraph(root);
      const logs = seedLogs(root);
      chmodSync(defaultGraphPath(), 0o444);

      await expect(minerOutcomes.run({ logs }, ctx())).resolves.toMatchObject({
        totals: { merged: 1 },
      });

      chmodSync(defaultGraphPath(), 0o644);
    });
  });
});
