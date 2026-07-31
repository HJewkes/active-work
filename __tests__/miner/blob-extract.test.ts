import { describe, expect, it } from 'vitest';

import { collectToolUses, extractBlobs, toolResultText } from '../../src/miner/blob-extract.js';

function userLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user',
    sessionId: 'session-1',
    timestamp: '2026-07-30T00:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
    },
    ...overrides,
  };
}

describe('collectToolUses', () => {
  it('pairs every tool_use block id with its tool name', () => {
    const line = {
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'running' },
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
        ],
      },
    };
    expect(collectToolUses(line)).toEqual([
      ['toolu_1', 'Bash'],
      ['toolu_2', 'Read'],
    ]);
  });

  it('ignores tool_use blocks missing an id or a name', () => {
    const line = {
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_1' },
          { type: 'tool_use', name: 'Bash' },
        ],
      },
    };
    expect(collectToolUses(line)).toEqual([]);
  });

  it('returns nothing for a line with no content array', () => {
    expect(collectToolUses({ message: { content: 'plain string' } })).toEqual([]);
    expect(collectToolUses({})).toEqual([]);
  });
});

describe('toolResultText', () => {
  it('passes a bare string through', () => {
    expect(toolResultText('boom')).toBe('boom');
  });

  it('joins the text of content blocks', () => {
    expect(
      toolResultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    ).toBe('a\nb');
  });

  it('yields an empty string for unusable content', () => {
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText(42)).toBe('');
  });
});

describe('extractBlobs', () => {
  it('routes an is_error result to the partition of the tool that produced it', () => {
    const line = userLine({
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: 'ENOENT: no such file',
          },
        ],
      },
    });
    const blobs = extractBlobs(line, new Map([['toolu_1', 'Read']]));
    expect(blobs).toEqual([
      {
        toolType: 'Read',
        rawText: 'ENOENT: no such file',
        sessionId: 'session-1',
        timestamp: '2026-07-30T00:00:00.000Z',
      },
    ]);
  });

  it('falls back to the generic partition when the tool_use was never seen', () => {
    const line = userLine({
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_unknown', is_error: true, content: 'boom' },
        ],
      },
    });
    expect(extractBlobs(line, new Map())[0].toolType).toBe('generic');
  });

  it('takes stdout and stderr from toolUseResult for a successful command', () => {
    const line = userLine({
      toolUseResult: { stdout: 'built ok', stderr: 'warning: deprecated', interrupted: false },
    });
    const blobs = extractBlobs(line, new Map([['toolu_1', 'Bash']]));
    expect(blobs).toHaveLength(1);
    expect(blobs[0].toolType).toBe('Bash');
    expect(blobs[0].rawText).toBe('built ok\nwarning: deprecated');
  });

  it('prefers the error text over toolUseResult when the result is an error', () => {
    const line = userLine({
      toolUseResult: { stdout: 'ignored', stderr: '' },
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: 'Permission denied',
          },
        ],
      },
    });
    expect(extractBlobs(line, new Map())[0].rawText).toBe('Permission denied');
  });

  it('skips results with no output to cluster', () => {
    expect(
      extractBlobs(userLine({ toolUseResult: { stdout: '', stderr: '   ' } }), new Map()),
    ).toEqual([]);
    expect(extractBlobs(userLine(), new Map())).toEqual([]);
  });

  it('skips non-tool-result and structured (non-stdout) results', () => {
    expect(
      extractBlobs(userLine({ toolUseResult: { matches: [], query: 'x' } }), new Map()),
    ).toEqual([]);
    expect(
      extractBlobs(
        { ...userLine(), message: { content: [{ type: 'text', text: 'hi' }] } },
        new Map(),
      ),
    ).toEqual([]);
  });

  it('requires a sessionId and a timestamp', () => {
    const result = { toolUseResult: { stdout: 'out', stderr: '' } };
    expect(extractBlobs({ ...userLine(result), sessionId: undefined }, new Map())).toEqual([]);
    expect(extractBlobs({ ...userLine(result), timestamp: undefined }, new Map())).toEqual([]);
  });

  it('consumes the tool_use_id so a later result cannot reuse a stale tool name', () => {
    const names = new Map([['toolu_1', 'Bash']]);
    const line = userLine({ toolUseResult: { stdout: 'out', stderr: '' } });
    expect(extractBlobs(line, names)[0].toolType).toBe('Bash');
    expect(names.has('toolu_1')).toBe(false);
    expect(extractBlobs(line, names)[0].toolType).toBe('generic');
  });
});
