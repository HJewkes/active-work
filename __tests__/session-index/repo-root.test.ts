import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { commandCwd, fileRef } from '@titan-design/session-read';

describe('fileRef', () => {
  it('does not name a repo for an unattributed file', () => {
    expect(fileRef(null, '/state/active-work/brief.md')).not.toContain('file:active-work/');
  });
});

describe('commandCwd', () => {
  const session = '/state/active-work';

  it.each([
    ['cd /projects/demo && git checkout -b feat/x', '/projects/demo'],
    ['cd /projects/demo; git commit -m x', '/projects/demo'],
    ['git -C /projects/demo checkout -b feat/x', '/projects/demo'],
    // `-C` is the more specific of the two and wins.
    ['cd /elsewhere && git -C /projects/demo push', '/projects/demo'],
  ])('anchors %s at %s', (command, expected) => {
    expect(commandCwd(command, session)).toBe(expected);
  });

  it('falls back to the session cwd when the command names no directory', () => {
    expect(commandCwd('git checkout -b feat/x', session)).toBe(session);
    expect(commandCwd('git checkout -b feat/x', null)).toBeNull();
  });

  it('resolves a relative cd against the session cwd', () => {
    expect(commandCwd('cd ../demo && git push', '/projects/other')).toBe('/projects/demo');
  });

  it('expands a leading ~', () => {
    expect(commandCwd('cd ~/projects/demo && git push', session)).toBe(
      path.join(os.homedir(), 'projects/demo'),
    );
  });
});
