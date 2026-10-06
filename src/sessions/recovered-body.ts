import type {
  CappedList,
  RecoveredCommand,
  RecoveredMessageTarget,
  SessionRecovery,
} from '@titan-design/session-read';

/** First body line of every recovered record. */
export const RECOVERED_FIRST_LINE =
  'Recovered from the transcript: this session ended without a wrap. Facts only, no narrative.';

function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => `> ${l}`.trimEnd())
    .join('\n');
}

function droppedNote(list: CappedList<unknown>): string[] {
  return list.dropped > 0 ? [`- …and ${list.dropped} more`] : [];
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ['', `## ${title}`, ...lines];
}

function commandLines(list: CappedList<RecoveredCommand>): string[] {
  if (list.items.length === 0) return [];
  const lines = list.items.map((c) => `- \`${c.head}\` ×${c.count}`);
  return [...lines, ...droppedNote(list)];
}

function targetLines(list: CappedList<RecoveredMessageTarget>): string[] {
  if (list.items.length === 0) return [];
  const lines = list.items.map((m) => `- ${m.target ?? '(unnamed)'}: ${m.firstLine}`);
  return [...lines, ...droppedNote(list)];
}

function ownerLines(recovery: SessionRecovery): string[] {
  // A blank line between quotes keeps each message its own blockquote.
  const lines = recovery.ownerMessages.flatMap((m, i) =>
    i === 0 ? [quote(m.text)] : ['', quote(m.text)],
  );
  if (lines.length > 0 && recovery.messageWindowTruncated) {
    lines.unshift('_Older owner messages fall outside the read window._');
  }
  return lines;
}

function header(recovery: SessionRecovery): string[] {
  return recovery.agentName === null
    ? [RECOVERED_FIRST_LINE]
    : [RECOVERED_FIRST_LINE, '', `- Agent name: ${recovery.agentName}`];
}

/** The record body: the owner's last words first, since they say what was in flight. */
export function renderRecoveredBody(recovery: SessionRecovery): string {
  const files = recovery.filesWritten;
  const lastReply = recovery.lastAssistantMessage;
  const lines = [
    ...header(recovery),
    ...section('Last owner messages', ownerLines(recovery)),
    ...section('Last assistant message', lastReply ? [quote(lastReply.text)] : []),
    ...section('active-work calls', commandLines(recovery.activeWorkCalls)),
    ...section('git and gh', commandLines(recovery.gitCommands)),
    ...section('Files written under the initiative', [
      ...files.items.map((f) => `- \`${f}\``),
      ...(files.items.length > 0 ? droppedNote(files) : []),
    ]),
    ...section('Messages sent', targetLines(recovery.chatSends)),
    ...section('Agents spawned', targetLines(recovery.agentSpawns)),
  ];
  return `${lines.join('\n')}\n`;
}
