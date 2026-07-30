import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TranscriptParseError,
  extractTranscript,
} from '../../../src/miner/session-index/extract.js';
import { prefixHash } from '../../../src/miner/session-index/prefix-hash.js';
import type { ExtractResult } from '../../../src/schemas/session-index.js';
import { FIXTURE_LINES, offsetAfterLine, renderTranscript } from './fixture.js';

let dir: string;
let transcript: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-extract-'));
  transcript = path.join(dir, 'session.jsonl');
  writeFileSync(transcript, renderTranscript(FIXTURE_LINES), 'utf8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Row kinds that are append-only or ref-keyed, so chunking can't change them. */
const STABLE_KINDS = [
  'facts',
  'spans',
  'permissionPhases',
  'humanEdits',
  'prs',
  'prMerges',
  'branches',
  'files',
  'tasks',
  'subagents',
  'artifacts',
  'edges',
  'turns',
] as const;

function sortedJson(rows: unknown[]): string[] {
  return rows.map((r) => JSON.stringify(r)).sort();
}

describe('extractTranscript', () => {
  it('emits one fact per non-blank line, tagged by event type', async () => {
    const result = await extractTranscript(transcript);

    expect(result.facts).toHaveLength(FIXTURE_LINES.length);
    const eventTypes = new Set(result.facts.map((f) => f.eventType));
    expect(eventTypes).toContain('user_prompt');
    expect(eventTypes).toContain('tool_decision');
    expect(eventTypes).toContain('assistant_response');
    expect(eventTypes).toContain('tool_result_error');
    expect(eventTypes).toContain('pr_link');
    expect(eventTypes).toContain('system_compact_boundary');
  });

  it('collects session metadata, turns, and per-model token buckets', async () => {
    const result = await extractTranscript(transcript);

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'sess-1',
      aiTitle: 'Demo session',
      seedPrompt: 'seed the demo',
      cwd: '/repo/demo',
      gitBranch: 'feat/x',
      startedAt: '2026-07-01T00:00:00Z',
      endedAt: '2026-07-01T00:00:19Z',
    });
    expect(result.turns.map((t) => t.promptId)).toEqual(['p1', 'p2']);
    expect(result.modelUsage).toEqual([
      {
        sessionId: 'sess-1',
        model: 'claude-opus-5',
        inputTokens: 90,
        outputTokens: 180,
        cacheReadTokens: 45,
        cacheCreationTokens: 18,
        thinkingTokens: 0,
        requestCount: 9,
      },
    ]);
  });

  it('extracts assets and relations while skipping ignored paths', async () => {
    const result = await extractTranscript(transcript);

    expect(result.files.map((f) => f.fileRef)).toEqual(['file:demo/src/app.ts']);
    expect(result.prs[0]).toMatchObject({
      prRef: 'pr:acme/demo#42',
      number: 42,
      repo: 'acme/demo',
    });
    expect(result.prMerges).toEqual([
      { number: 42, repoHint: 'demo', mergedAt: '2026-07-01T00:00:16Z' },
    ]);
    expect(result.branches.map((b) => b.branchRef).sort()).toEqual([
      'branch:demo/feat/x',
      'branch:demo/feat/y',
    ]);
    expect(result.tasks.map((t) => t.taskRef)).toEqual(['task:AW-23']);
    expect(result.subagents[0]).toMatchObject({ agentRef: 'agent:t3', agentType: 'Explore' });
    expect(result.artifacts.map((a) => a.artifactRef).sort()).toEqual([
      'artifact:https://frames/1',
      'artifact:t5',
    ]);
    expect(result.humanEdits).toHaveLength(1);

    const relations = result.edges.map((e) => `${e.sourceRef} ${e.relation} ${e.targetRef}`);
    expect(relations).toContain('session:sess-1 touched file:demo/src/app.ts');
    expect(relations).toContain('session:sess-1 linked pr:acme/demo#42');
    expect(relations).toContain('pr:acme/demo#42 built_on branch:demo/feat/x');
    expect(relations).toContain('session:sess-1 worked branch:demo/feat/y');
    expect(relations).toContain('session:sess-1 ran task:AW-23');
    expect(relations).toContain('session:sess-1 spawned agent:t3');
  });

  it('records both mode and permission-mode phase candidates', async () => {
    const result = await extractTranscript(transcript);

    expect(result.permissionPhases).toEqual([
      expect.objectContaining({ trigger: 'mode', toMode: 'plan' }),
      expect.objectContaining({ trigger: 'permission-mode', toMode: 'acceptEdits' }),
    ]);
  });

  it('resuming from a mid-file watermark yields only the delta rows', async () => {
    const watermark = offsetAfterLine(FIXTURE_LINES, 5);
    const hash = await prefixHash(transcript, watermark);

    const delta = await extractTranscript(transcript, {
      fromByteOffset: watermark,
      priorPrefixHash: hash,
    });

    expect(delta.restartedFromZero).toBe(false);
    expect(delta.startByteOffset).toBe(watermark);
    expect(delta.facts).toHaveLength(FIXTURE_LINES.length - 5);
    expect(delta.facts.every((f) => f.byteOffset >= watermark)).toBe(true);
    expect(delta.turns.map((t) => t.promptId)).toEqual(['p2']);
  });

  it('re-reads from byte 0 when the stored prefix hash no longer matches', async () => {
    const watermark = offsetAfterLine(FIXTURE_LINES, 5);

    const result = await extractTranscript(transcript, {
      fromByteOffset: watermark,
      priorPrefixHash: 'stale-hash-from-a-rewritten-file',
    });

    expect(result.restartedFromZero).toBe(true);
    expect(result.startByteOffset).toBe(0);
    expect(result.facts).toHaveLength(FIXTURE_LINES.length);
  });

  it('throws a locating error for a malformed line', async () => {
    writeFileSync(transcript, '{"sessionId":"s"}\nnot json\n', 'utf8');

    await expect(extractTranscript(transcript)).rejects.toBeInstanceOf(TranscriptParseError);
  });

  it('produces the same append-only rows chunked as in one full pass', async () => {
    const split = offsetAfterLine(FIXTURE_LINES, 8);
    const full = await extractTranscript(transcript);

    const first = await extractTranscript(transcript, { untilByteOffset: split });
    const second = await extractTranscript(transcript, {
      fromByteOffset: first.lastByteOffset,
      priorPrefixHash: first.prefixHash,
    });

    expect(first.lastByteOffset).toBe(split);
    expect(second.restartedFromZero).toBe(false);
    for (const kind of STABLE_KINDS) {
      const chunked = [...first[kind], ...second[kind]] as unknown[];
      expect(sortedJson(dedupeByRef(kind, chunked))).toEqual(sortedJson(full[kind] as unknown[]));
    }
  });
});

/**
 * Ref-keyed rows are deduped per chunk, so an asset touched on both sides of a
 * split legitimately appears twice across chunks — the writer's upserts
 * collapse them. Mirror that collapse here to compare against the full pass.
 */
function dedupeByRef(kind: (typeof STABLE_KINDS)[number], rows: unknown[]): unknown[] {
  const REF_KEYS: Partial<Record<(typeof STABLE_KINDS)[number], string>> = {
    prs: 'prRef',
    branches: 'branchRef',
    files: 'fileRef',
    tasks: 'taskRef',
    subagents: 'agentRef',
    artifacts: 'artifactRef',
    turns: 'promptId',
  };
  const key = REF_KEYS[kind];
  if (kind === 'edges') return dedupeBy(rows, (r) => edgeKey(r as ExtractResult['edges'][number]));
  if (!key) return rows;
  return dedupeBy(rows, (r) => String((r as Record<string, unknown>)[key]));
}

function edgeKey(edge: ExtractResult['edges'][number]): string {
  return `${edge.sourceRef} ${edge.relation} ${edge.targetRef}`;
}

function dedupeBy(rows: unknown[], keyOf: (row: unknown) => string): unknown[] {
  const seen = new Map<string, unknown>();
  for (const row of rows) if (!seen.has(keyOf(row))) seen.set(keyOf(row), row);
  return [...seen.values()];
}
