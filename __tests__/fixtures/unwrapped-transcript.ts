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
  /** `cli` for an interactive session, `sdk-cli` for a headless one. */
  entrypoint?: string;
  /** When the last line was written; lines are one second apart before it. */
  endsAt?: Date;
}

export const DEFAULT_ENDS_AT = new Date('2026-10-05T21:00:11.000Z');

export const OWNER_MESSAGES = [
  'Write the handoff before the reboot.',
  'File the two follow-ups as tasks.',
  'Then push and tell the coordinator.',
];

export const LAST_ASSISTANT_TEXT = 'Handoff written, tasks filed, branch pushed.';

type Header = Pick<UnwrappedTranscriptInput, 'sessionId' | 'cwd'> & { entrypoint: string };

function line(header: Header, type: 'user' | 'assistant', content: unknown) {
  return { type, ...header, message: { role: type, content } };
}

function stamped(lines: Record<string, unknown>[], endsAt: Date): Record<string, unknown>[] {
  return lines.map((l, i) => ({
    ...l,
    uuid: `u-${i + 1}`,
    timestamp: new Date(endsAt.getTime() - (lines.length - 1 - i) * 1000).toISOString(),
  }));
}

function toolUse(id: string, name: string, input: Record<string, unknown>): unknown[] {
  return [{ type: 'tool_use', id, name, input }];
}

function bash(id: string, command: string): unknown[] {
  return toolUse(id, 'Bash', { command });
}

function body(header: Header): Record<string, unknown>[] {
  const { cwd } = header;
  const at = (type: 'user' | 'assistant', content: unknown) => line(header, type, content);
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
  mkdirSync(input.projectDir, { recursive: true });
  const file = path.join(input.projectDir, `${input.sessionId}.jsonl`);
  const header = {
    sessionId: input.sessionId,
    cwd: input.cwd,
    entrypoint: input.entrypoint ?? 'cli',
  };
  const lines = stamped(body(header), input.endsAt ?? DEFAULT_ENDS_AT).map((l) =>
    JSON.stringify(l),
  );
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}
