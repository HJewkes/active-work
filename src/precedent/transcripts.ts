import type Database from 'better-sqlite3';
import {
  claudeSourceFromPath,
  readClaudeObservations,
  toAbsolutePath,
} from '@titan-design/session-read';
import { classifyQuestion } from './classify.js';
import { answerFor, parseAnswerText, pickTypeOf, recommendedOption } from './parse-answer.js';
import type { PrecedentRow } from './schema.js';

/**
 * Precedents from `AskUserQuestion` calls, located through the miner graph and
 * read back from the transcripts themselves. The graph stores only locators,
 * so the question and answer text is read at extract time and never lands in
 * the graph.
 */

export interface AskCall {
  sessionId: string;
  toolUseId: string;
  askedAt: string;
  sourceKey: string;
  cwd: string | null;
}

interface QuestionInput {
  header?: unknown;
  question?: unknown;
  options?: unknown;
}

export type InitiativeResolver = (cwd: string | null) => Promise<string | null>;

export function transcriptKey(sessionId: string, toolUseId: string): string {
  return `transcript:${sessionId}:${toolUseId}`;
}

export function listAskCalls(graph: Database.Database): AskCall[] {
  return graph
    .prepare(
      `SELECT c.session_id AS sessionId, c.tool_use_id AS toolUseId, c.ts AS askedAt,
              t.source_key AS sourceKey, s.cwd AS cwd
         FROM tool_call c
         JOIN transcript t ON t.source_id = c.transcript_id
         LEFT JOIN session s ON s.session_id = c.session_id
        WHERE c.name = 'AskUserQuestion'
        ORDER BY c.ts`,
    )
    .all() as AskCall[];
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((part: unknown) =>
        typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '',
      )
      .join(' ');
  }
  return JSON.stringify(output ?? '');
}

interface CallText {
  input: Map<string, unknown>;
  result: Map<string, string>;
}

/** Inputs and results for the wanted calls, each paired by its own `tool_use_id`. */
async function readCallText(sourceKey: string, wanted: Set<string>): Promise<CallText> {
  const input = new Map<string, unknown>();
  const result = new Map<string, string>();
  const source = claudeSourceFromPath(toAbsolutePath(sourceKey), 'default');
  for await (const obs of readClaudeObservations(source)) {
    if (obs.kind === 'tool_call' && wanted.has(obs.call.nativeId)) {
      input.set(obs.call.nativeId, obs.input);
    } else if (obs.kind === 'tool_result' && wanted.has(obs.call.nativeId)) {
      result.set(obs.call.nativeId, outputText(obs.output));
    }
  }
  return { input, result };
}

function questionsOf(input: unknown): QuestionInput[] {
  const questions = (input as { questions?: unknown } | null)?.questions;
  return Array.isArray(questions)
    ? questions.filter((q): q is QuestionInput => typeof q === 'object' && q !== null)
    : [];
}

function optionLabels(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.map((o: unknown) =>
    typeof o === 'object' && o !== null && 'label' in o ? String(o.label) : String(o),
  );
}

export function rowsForCall(
  call: AskCall,
  input: unknown,
  resultText: string,
  initiative: string | null,
): PrecedentRow[] {
  const parsed = parseAnswerText(resultText);
  return questionsOf(input).map((q) => {
    const question = typeof q.question === 'string' ? q.question : '';
    const header = typeof q.header === 'string' ? q.header : '';
    const options = optionLabels(q.options);
    const answer = parsed.rejected ? null : answerFor(parsed.answers, question);
    const pick = pickTypeOf(answer, options, parsed.rejected);
    return {
      key: transcriptKey(call.sessionId, call.toolUseId),
      source: 'transcript',
      asked_at: call.askedAt,
      session_id: call.sessionId,
      tool_use_id: call.toolUseId,
      initiative,
      class: classifyQuestion({ header, question, options }),
      header,
      question,
      options,
      recommended: recommendedOption(options),
      answer,
      pick_type: pick,
      free_text: pick === 'free_text' ? answer : null,
    };
  });
}

export interface TranscriptExtract {
  rows: PrecedentRow[];
  /** Calls whose tool result has not been written yet; retried on the next run. */
  pending: number;
  errors: string[];
}

function groupBySource(calls: AskCall[]): Map<string, AskCall[]> {
  const groups = new Map<string, AskCall[]>();
  for (const call of calls) {
    const group = groups.get(call.sourceKey) ?? [];
    group.push(call);
    groups.set(call.sourceKey, group);
  }
  return groups;
}

export async function extractTranscriptRows(
  calls: AskCall[],
  resolveInitiative: InitiativeResolver,
): Promise<TranscriptExtract> {
  const out: TranscriptExtract = { rows: [], pending: 0, errors: [] };
  for (const [sourceKey, group] of groupBySource(calls)) {
    let text: CallText;
    try {
      text = await readCallText(sourceKey, new Set(group.map((c) => c.toolUseId)));
    } catch (err) {
      out.errors.push(`${sourceKey}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const call of group) {
      const result = text.result.get(call.toolUseId);
      if (result === undefined) {
        out.pending += 1;
        continue;
      }
      const initiative = await resolveInitiative(call.cwd);
      out.rows.push(...rowsForCall(call, text.input.get(call.toolUseId), result, initiative));
    }
  }
  return out;
}
