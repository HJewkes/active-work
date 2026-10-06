import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import wrap from '../../src/commands/wrap.js';
import {
  handleOnComplete,
  resetWrapRunner,
  setWrapRunner,
} from '../../src/commands/hooks-agent-chat-complete.js';
import { stashSpawnContext } from '../../src/utils/agent-chat-hook-state.js';
import { setGitRunner, resetRunners } from '../../src/utils/git-gh.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/agent-chat/on-complete-worker.json',
);

type Payload = Record<string, unknown> & { facts: Record<string, unknown> };

async function loadPayload(): Promise<Payload> {
  return JSON.parse(await fs.readFile(FIXTURE, 'utf8')) as Payload;
}

/** Turn the hook's argv back into wrap args through wrap's own option table. */
function argsFromArgv(argv: string[]): Record<string, unknown> {
  const byLong = new Map(Object.entries(wrap.cli?.options ?? {}).map(([k, o]) => [o.long, k]));
  const [, slug, ...rest] = argv;
  const args: Record<string, unknown> = { slug };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i] ?? '';
    const key = byLong.get(flag);
    if (key === undefined) throw new Error(`wrap has no option ${flag}`);
    if (flag.startsWith('--no-')) args[key] = true;
    else args[key] = rest[++i];
  }
  return args;
}

/** Runs the real wrap in-process, so the record on disk is what the hook produces. */
function inProcessWrap(activeRoot: string, written: string[]): void {
  setWrapRunner(async (argv) => {
    const result = await wrap.run(wrap.args.parse(argsFromArgv(argv)), {
      activeRoot,
      warnings: [],
      format: 'json',
    });
    written.push(result.path);
    return { code: 0, stderr: '' };
  });
}

async function readRecord(file: string): Promise<{ front: Record<string, unknown>; body: string }> {
  const raw = await fs.readFile(file, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  return {
    front: YAML.parse(match?.[1] ?? '') as Record<string, unknown>,
    body: match?.[2] ?? '',
  };
}

async function recordFor(payload: Record<string, unknown>, warnings: string[] = []) {
  return withTempActiveRoot(async (activeRoot) => {
    await stashSpawnContext(String(payload.agentId), {
      slug: SLUG,
      sessionId: 'sess-worker',
      name: String(payload.agentId),
      started: '2026-10-05T09:00:00.000Z',
      profile: 'implementer',
    });
    const written: string[] = [];
    inProcessWrap(activeRoot, written);
    await handleOnComplete(payload, warnings);
    expect(written).toHaveLength(1);
    return readRecord(written[0] ?? '');
  });
}

beforeEach(() => {
  setGitRunner(() => Promise.resolve({ code: 1, stdout: '', stderr: '' }));
});

afterEach(() => {
  resetWrapRunner();
  resetRunners();
});

describe('hooks agent-chat-complete with worker facts', () => {
  it('records a reporting worker with its task, PR and Status line', async () => {
    const { front, body } = await recordFor(await loadPayload());

    expect(front.kind).toBe('worker');
    expect(front.track).toBe('adhoc');
    expect(front.no_loops).toBe(true);
    const worker = front.worker as { facts: Record<string, unknown>; resolves?: string[] };
    expect(worker.facts.taskId).toBe('SX-42');
    expect(worker.facts.pr).toEqual({ repo: 'example-org/sample-repo', number: 17 });
    expect(worker.resolves).toEqual(['SX-42']);
    expect(body).toMatch(/^Status: DONE$/m);
    expect(body).toContain('PR: example-org/sample-repo#17');
    expect(body).not.toMatch(/exited with code/);
  });

  it('keeps a report that opens with a --- block out of the frontmatter', async () => {
    const payload = await loadPayload();
    const text = [
      '---',
      'Status: DONE',
      'PR: example-org/sample-repo#17',
      'parent_session_id: hijacked-1234',
      'kind: worker',
      '---',
      'SX-42 closed.',
    ].join('\n');
    const report = { messageId: 'msg-0002', kind: 'status', text };
    const { front, body } = await recordFor({ ...payload, facts: { ...payload.facts, report } });

    expect(Object.keys(front).sort()).toEqual([
      'ended',
      'kind',
      'next_steps',
      'no_loops',
      'resolves',
      'session_id',
      'started',
      'track',
      'worker',
    ]);
    expect(front.parent_session_id).toBeUndefined();
    expect((front.worker as { facts: { report: { text: string } } }).facts.report.text).toBe(text);
    expect(body.trim()).toBe(text);
  });

  it('records a worker that sent no report as exited-no-report with its last action', async () => {
    const payload = await loadPayload();
    const { report: _report, pr: _pr, ...facts } = payload.facts;
    const { front, body } = await recordFor({
      ...payload,
      code: 1,
      facts: { ...facts, exit: { code: 1, signal: null, inferred: false } },
      lastAction: 'Bash: pnpm vitest run __tests__/widget.test.ts',
    });

    const worker = front.worker as Record<string, unknown>;
    expect(worker.outcome).toBe('exited-no-report');
    expect(worker.last_action).toBe('Bash: pnpm vitest run __tests__/widget.test.ts');
    expect(body).toContain('Last action: Bash: pnpm vitest run');
    expect(body).not.toMatch(/exited with code/);
  });

  it('keeps recording a payload without facts the way an older broker expects', async () => {
    const { facts: _facts, ...legacy } = await loadPayload();
    const { front, body } = await recordFor(legacy);

    expect(front.kind).toBeUndefined();
    expect(front.worker).toBeUndefined();
    expect(body).toContain('exited with code 0');
  });

  it('falls back to the one-line record with a warning when facts fail the schema', async () => {
    const payload = await loadPayload();
    const warnings: string[] = [];
    const { front } = await recordFor(
      { ...payload, facts: { ...payload.facts, spawner: '' } },
      warnings,
    );

    expect(front.worker).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/facts failed validation/);
  });
});
