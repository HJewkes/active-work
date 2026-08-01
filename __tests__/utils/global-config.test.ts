import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FALLBACK_DEFAULT_CHANNELS,
  readGlobalConfig,
  resolveDefaultChannels,
} from '../../src/utils/global-config.js';

let configRoot: string;

beforeEach(async () => {
  configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-test-'));
});

afterEach(async () => {
  await fs.rm(configRoot, { recursive: true, force: true });
});

async function writeConfig(content: unknown): Promise<void> {
  await fs.writeFile(path.join(configRoot, 'config.json'), JSON.stringify(content), 'utf8');
}

describe('readGlobalConfig', () => {
  it('returns {} when config.json does not exist', async () => {
    expect(await readGlobalConfig(configRoot)).toEqual({});
  });

  it('returns {} when config.json is not valid JSON', async () => {
    await fs.writeFile(path.join(configRoot, 'config.json'), '{not json', 'utf8');
    expect(await readGlobalConfig(configRoot)).toEqual({});
  });

  it('returns {} when channels fails schema validation, rather than throwing', async () => {
    await writeConfig({ channels: [123] });
    expect(await readGlobalConfig(configRoot)).toEqual({});
  });

  it('parses a valid channels list', async () => {
    await writeConfig({ channels: ['plugin:foo@market', 'bare-server'] });
    expect(await readGlobalConfig(configRoot)).toEqual({
      channels: ['plugin:foo@market', 'bare-server'],
    });
  });

  it('ignores unrelated keys like discovery without failing', async () => {
    await writeConfig({ discovery: { githubRepos: ['a/b'] }, channels: ['plugin:foo@market'] });
    expect(await readGlobalConfig(configRoot)).toEqual({ channels: ['plugin:foo@market'] });
  });
});

describe('resolveDefaultChannels', () => {
  it('falls back to the shipped default when config.json is absent', async () => {
    expect(await resolveDefaultChannels(configRoot)).toEqual(FALLBACK_DEFAULT_CHANNELS);
  });

  it('falls back to the shipped default when channels is an empty array', async () => {
    await writeConfig({ channels: [] });
    expect(await resolveDefaultChannels(configRoot)).toEqual(FALLBACK_DEFAULT_CHANNELS);
  });

  it('uses the configured channels when present, replacing the fallback entirely', async () => {
    await writeConfig({ channels: ['plugin:custom@market'] });
    expect(await resolveDefaultChannels(configRoot)).toEqual(['plugin:custom@market']);
  });
});
