import { describe, expect, it } from 'vitest';

import { transcriptFromPath } from '../../src/session-index/transcript-path.js';

const roots = [
  { root: '/srv/demo/.claude/projects', account: 'default' },
  { root: '/srv/demo/.claude-profiles/work/projects', account: 'work' },
];

describe('transcriptFromPath', () => {
  it('describes a session transcript with a home-relative display path and its account', () => {
    expect(
      transcriptFromPath(
        '/srv/demo/.claude-profiles/work/projects/demo/s1.jsonl',
        roots,
        '/srv/demo',
      ),
    ).toEqual({
      projectDir: 'demo',
      absolutePath: '/srv/demo/.claude-profiles/work/projects/demo/s1.jsonl',
      displayPath: '~/.claude-profiles/work/projects/demo/s1.jsonl',
      subagentId: null,
      account: 'work',
    });
  });

  it('reads the subagent id from a sidechain path', () => {
    const found = transcriptFromPath(
      '/srv/demo/.claude/projects/demo/s1/subagents/agent-abc.jsonl',
      roots,
      '/srv/demo',
    );

    expect(found).toMatchObject({ projectDir: 'demo', subagentId: 'abc', account: 'default' });
  });

  it.each([
    '/elsewhere/demo/s1.jsonl',
    '/srv/demo/.claude/projects/demo/s1.txt',
    '/srv/demo/.claude/projects/demo/s1/other/agent-abc.jsonl',
    '/srv/demo/.claude/projects/demo/s1/subagents/notes.jsonl',
    '/srv/demo/.claude/projects/s1.jsonl',
  ])('returns null for %s, which discovery would not list', (file) => {
    expect(transcriptFromPath(file, roots, '/srv/demo')).toBeNull();
  });
});
