import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import '../../src/commands/index.js';
import { registry } from '../../src/registry/index.js';
import { commandNameToToolName } from '../../src/server/mcp.js';

/**
 * The MCP tool name is the public contract: it appears in every consumer's
 * config and in `~/.claude.json`. Renaming one silently breaks callers that
 * this repo cannot see, so the whole list is pinned to a fixture rather than
 * spot-checked. Added in AW-a, where the registry moved onto
 * `@titan-design/registry` and the command surface had to come through byte
 * for byte.
 *
 * If this fails because a command was deliberately added or renamed, update
 * the fixture in the same commit and say so in the message.
 */
const FIXTURE = new URL('./__fixtures__/mcp-tool-names.json', import.meta.url);

describe('MCP tool names', () => {
  it('match the committed fixture exactly', () => {
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as string[];
    const actual = registry.list().map((cmd) => commandNameToToolName(cmd.name));
    expect(actual).toEqual(expected);
  });

  it('projects a dotted command name onto its double-underscore tool name', () => {
    expect(commandNameToToolName('task.add')).toBe('active__task__add');
    expect(commandNameToToolName('artifact.add-branch')).toBe('active__artifact__add-branch');
  });

  it('is sorted, so a consumer diffing the list sees only real changes', () => {
    const actual = registry.list().map((cmd) => cmd.name);
    expect(actual).toEqual([...actual].sort((a, b) => a.localeCompare(b)));
  });
});
