import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A synthetic Claude transcript shaped like an operator session that ended
 * without a wrap: it writes a handoff file, files tasks, pushes, messages a
 * peer, spawns a worker, and ends on owner messages nobody answered.
 *
 * Built at test time because the written paths must sit under the test's own
 * initiative directory. Never replace this with a real transcript: the repo is
 * public.
 */
export interface UnwrappedTranscriptInput {
  /** `<configDir>/projects/<project slug>` the transcript lands in. */
  projectDir: string;
  sessionId: string;
  /** The initiative directory the session launched in. */
  cwd: string;
}

export const OWNER_MESSAGES = [
  'Write the handoff before the reboot.',
  'File the two follow-ups as tasks.',
  'Then push and tell the coordinator.',
];

export const LAST_ASSISTANT_TEXT = 'Handoff written, tasks filed, branch pushed.';

let tick = 0;

function stamp(): string {
  tick += 1;
  return new Date(Date.UTC(2026, 9, 5, 21, 0, tick)).toISOString();
}

function line(
  sessionId: string,
  cwd: string,
  type: 'user' | 'assistant',
  content: unknown,
): Record<string, unknown> {
  const timestamp = stamp();
  return { type, sessionId, cwd, uuid: `u-${tick}`, timestamp, message: { role: type, content } };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): unknown[] {
  return [{ type: 'tool_use', id, name, input }];
}

function bash(id: string, command: string): unknown[] {
  return toolUse(id, 'Bash', { command });
}

function body(sessionId: string, cwd: string): Record<string, unknown>[] {
  const at = (type: 'user' | 'assistant', content: unknown) => line(sessionId, cwd, type, content);
  return [
    at('user', OWNER_MESSAGES[0]),
    at(
      'assistant',
      toolUse('t1', 'mcp__plugin_agent-chat_agent-chat__chat_register', { name: 'operator' }),
    ),
    at(
      'assistant',
      toolUse('t2', 'Write', { file_path: path.join(cwd, 'handoff-notes.md'), content: 'x' }),
    ),
    at('user', OWNER_MESSAGES[1]),
    at('assistant', bash('t3', 'active-work task add demo --title "First follow-up"')),
    at('assistant', bash('t4', 'active-work task add demo --title "Second follow-up"')),
    at('user', OWNER_MESSAGES[2]),
    at('assistant', bash('t5', 'git push origin HEAD')),
    at(
      'assistant',
      toolUse('t6', 'mcp__plugin_agent-chat_agent-chat__chat_send', {
        to: 'coordinator',
        text: 'Handoff is in place.\nDetails follow.',
      }),
    ),
    at(
      'assistant',
      toolUse('t7', 'mcp__plugin_agent-chat_agent-chat__agent_spawn', {
        name: 'worker-one',
        brief: 'Pick up the first follow-up.',
      }),
    ),
    at('assistant', [{ type: 'text', text: LAST_ASSISTANT_TEXT }]),
  ];
}

/** Write the transcript and return its path. */
export function writeUnwrappedTranscript(input: UnwrappedTranscriptInput): string {
  tick = 0;
  mkdirSync(input.projectDir, { recursive: true });
  const file = path.join(input.projectDir, `${input.sessionId}.jsonl`);
  const lines = body(input.sessionId, input.cwd).map((l) => JSON.stringify(l));
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}
