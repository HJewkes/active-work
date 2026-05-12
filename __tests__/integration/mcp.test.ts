/**
 * Smoke test for the stdio MCP server.
 *
 * Spawns a child process running the MCP server, hands it stdio, drives a
 * `tools/list` request through an MCP `Client`, and asserts a sensible
 * response. We spawn via `tsx -e` so this test is independent of Wave 3.1's
 * CLI work (the eventual public entrypoint is `aw mcp serve --stdio`).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server', 'mcp.ts').replaceAll('\\', '\\\\');
const SERVER_ENTRY_SRC = `import('${SERVER_PATH}').then((m) => m.runMcpStdio()).catch((e) => { console.error(e); process.exit(1); });`;

describe('integration: stdio MCP server', () => {
  beforeAll(() => {
    expect(existsSync(TSX_BIN)).toBe(true);
  });

  it('handshakes and lists tools over real stdio', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aw-mcp-int-'));
    try {
      const filteredEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') filteredEnv[k] = v;
      }
      filteredEnv.ACTIVE_ROOT = root;

      const transport = new StdioClientTransport({
        command: TSX_BIN,
        args: ['-e', SERVER_ENTRY_SRC],
        env: filteredEnv,
        stderr: 'pipe',
      });

      const client = new Client(
        { name: 'integration-test', version: '0.0.0' },
        { capabilities: {} },
      );
      await client.connect(transport);

      const listed = await client.listTools();
      expect(listed.tools.length).toBeGreaterThanOrEqual(34);

      const names = listed.tools.map((t) => t.name);
      expect(names).toContain('active__list');
      expect(names).toContain('active__task__add');
      expect(names).toContain('active__mcp__serve');

      const result = await client.callTool({
        name: 'active__list',
        arguments: {},
      });
      expect(result.isError).toBe(false);
      const content = result.content as Array<{ type: string; text: string }>;
      const envelope = JSON.parse(content[0]!.text) as { ok: boolean };
      expect(envelope.ok).toBe(true);

      await client.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
