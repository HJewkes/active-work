import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveResumeChannels } from '../src/resume-channels.js';
import { withEmptyActiveRoot } from './setup/test-helpers.js';

let configRoot: string;

beforeEach(() => {
  configRoot = mkdtempSync(path.join(os.tmpdir(), 'aw-resume-config-'));
});

afterEach(() => rmSync(configRoot, { recursive: true, force: true }));

async function writeBrief(activeRoot: string, slug: string, channels: string[]): Promise<void> {
  const dir = path.join(activeRoot, slug);
  await fs.mkdir(dir, { recursive: true });
  const list = channels.map((c) => `  - ${c}`).join('\n');
  await fs.writeFile(
    path.join(dir, 'brief.md'),
    `---\nschema_version: 1\ntitle: Synthetic\nupdated: 2026-05-10\nstate: focused\nrank: 1\ntask_prefix: SY\nchannels:\n${list}\n---\n\n# Synthetic\n`,
  );
}

async function writeConfig(channels: string[]): Promise<void> {
  await fs.writeFile(path.join(configRoot, 'config.json'), JSON.stringify({ channels }));
}

describe('resolveResumeChannels', () => {
  it('merges the global default with the channels of the initiative the session belongs to', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await writeBrief(activeRoot, 'synthetic-app', ['plugin:extra@market']);
      await writeConfig(['plugin:agent-chat@agent-chat-local']);

      const channels = await resolveResumeChannels(
        activeRoot,
        { cwd: '/synthetic/cwd', slug: 'synthetic-app' },
        configRoot,
      );

      expect(channels).toEqual(['plugin:agent-chat@agent-chat-local', 'plugin:extra@market']);
    });
  });

  it('falls back to the global default when no initiative resolves', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      await writeConfig(['plugin:configured@market']);

      const channels = await resolveResumeChannels(
        activeRoot,
        { cwd: '/synthetic/nowhere' },
        configRoot,
      );

      expect(channels).toEqual(['plugin:configured@market']);
    });
  });

  it('launches without channels when no initiative resolves and none are configured', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const channels = await resolveResumeChannels(
        activeRoot,
        { cwd: '/synthetic/nowhere' },
        configRoot,
      );

      expect(channels).toEqual([]);
    });
  });
});
