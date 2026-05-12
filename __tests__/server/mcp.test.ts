import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { z } from 'zod';
import { withTempActiveRoot } from '../setup/test-helpers.js';
import {
  commandNameToToolName,
  toolNameToCommandName,
  commandToTool,
  listTools,
  invokeTool,
  createMcpServer,
} from '../../src/server/mcp.js';
import { registry } from '../../src/registry/index.js';
import '../../src/commands/index.js'; // populate the registry

describe('commandNameToToolName / toolNameToCommandName', () => {
  it('maps nested command names through double underscores', () => {
    expect(commandNameToToolName('task.add')).toBe('active__task__add');
    expect(commandNameToToolName('list')).toBe('active__list');
    expect(commandNameToToolName('mcp.serve')).toBe('active__mcp__serve');
  });

  it('round-trips back to the command name', () => {
    expect(toolNameToCommandName('active__task__add')).toBe('task.add');
    expect(toolNameToCommandName('active__list')).toBe('list');
  });

  it('returns null for non-active tools', () => {
    expect(toolNameToCommandName('some_other_tool')).toBeNull();
    expect(toolNameToCommandName('')).toBeNull();
  });
});

describe('commandToTool', () => {
  it('produces an object inputSchema with type=object', () => {
    const taskAdd = registry.get('task.add');
    expect(taskAdd).toBeDefined();
    const tool = commandToTool(taskAdd!);
    expect(tool.name).toBe('active__task__add');
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema).toBeTypeOf('object');
    expect(tool.inputSchema['type']).toBe('object');
    // The slug + title fields should appear in properties.
    const props = tool.inputSchema['properties'] as Record<string, unknown>;
    expect(props).toBeDefined();
    expect(props['slug']).toBeDefined();
    expect(props['title']).toBeDefined();
  });

  it('strips top-level $schema and definitions', () => {
    const list = registry.get('list');
    const tool = commandToTool(list!);
    expect(tool.inputSchema['$schema']).toBeUndefined();
    expect(tool.inputSchema['definitions']).toBeUndefined();
  });
});

describe('listTools', () => {
  it('returns one tool per registered command', () => {
    const tools = listTools();
    expect(tools.length).toBe(registry.size);
    // Sanity: enough commands wired through.
    expect(tools.length).toBeGreaterThanOrEqual(34);
  });

  it('every tool has name, description, and an object inputSchema', () => {
    for (const tool of listTools()) {
      expect(tool.name).toMatch(/^active__/);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema['type']).toBe('object');
    }
  });
});

describe('invokeTool', () => {
  it('returns isError:false with a JSON envelope for a benign read', async () => {
    await withTempActiveRoot(async () => {
      const out = await invokeTool('active__list', {});
      expect(out.isError).toBe(false);
      expect(out.envelope.ok).toBe(true);
      if (out.envelope.ok) {
        expect(out.envelope.data).toHaveProperty('sections');
      }
    });
  });

  it('returns isError:true for an unknown tool', async () => {
    const out = await invokeTool('active__does__not__exist', {});
    expect(out.isError).toBe(true);
    expect(out.envelope.ok).toBe(false);
    if (!out.envelope.ok) {
      expect(out.envelope.error).toMatch(/Unknown tool/);
    }
  });

  it('returns isError:true with a clear message for invalid args', async () => {
    await withTempActiveRoot(async () => {
      // task.add requires `slug` and `title`; pass neither.
      const out = await invokeTool('active__task__add', {});
      expect(out.isError).toBe(true);
      expect(out.envelope.ok).toBe(false);
      if (!out.envelope.ok) {
        expect(out.envelope.error).toMatch(/Invalid arguments/i);
      }
    });
  });
});

describe('createMcpServer (in-memory client round-trip)', () => {
  it('handles ListTools and CallTool over the linked transport pair', async () => {
    await withTempActiveRoot(async () => {
      const server = createMcpServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const listed = await client.listTools();
      expect(listed.tools.length).toBe(registry.size);

      const callResult = await client.callTool({
        name: 'active__list',
        arguments: {},
      });
      expect(callResult.isError).toBe(false);
      const content = callResult.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0]?.type).toBe('text');
      const parsed = JSON.parse(content[0]!.text!) as z.infer<ReturnType<typeof z.object>> & {
        ok: boolean;
      };
      expect(parsed.ok).toBe(true);

      const badCall = await client.callTool({
        name: 'active__task__add',
        arguments: {},
      });
      expect(badCall.isError).toBe(true);
      const badContent = badCall.content as Array<{ text: string }>;
      const badEnv = JSON.parse(badContent[0]!.text) as {
        ok: false;
        error: string;
      };
      expect(badEnv.ok).toBe(false);
      expect(badEnv.error).toMatch(/Invalid arguments/i);

      await client.close();
      await server.close();
    });
  });
});
