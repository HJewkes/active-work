import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import {
  classifyQuestion,
  type LedgerRowWire,
  type LedgerSource,
  type SourceRead,
  type SourceWatermarks,
} from '@titan-design/decider';

/**
 * Precedents from agent-chat's human queue: each `answer` event paired with
 * the `question` it answers (`answer.ref` is the question's `msg_id`). Read
 * directly from `events.db`, read-only, under the same temporary coupling as
 * `session-index/origin-agent-chat.ts`, until TP-699 moves this source out of
 * active-work.
 */

export const QUEUE_SOURCE = 'queue';
const CURSOR = 'events';

interface AnswerRow {
  id: number;
  ts: number;
  msgId: string | null;
  question: string | null;
  answer: string | null;
}

function readAnswers(eventsDbPath: string, afterId: number): AnswerRow[] {
  const db = new Database(eventsDbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT a.id AS id, a.ts AS ts, a.msg_id AS msgId, q.body AS question, a.body AS answer
           FROM events a
           JOIN events q ON q.msg_id = a.ref AND q.kind = 'question'
          WHERE a.kind = 'answer' AND a.id > ?
          ORDER BY a.id`,
      )
      .all(afterId) as AnswerRow[];
  } finally {
    db.close();
  }
}

function queueRow(eventsDbPath: string, row: AnswerRow): LedgerRowWire {
  const question = row.question ?? '';
  return {
    key: `queue:${row.id}`,
    v: 2,
    source: 'queue',
    asked_at: new Date(row.ts).toISOString(),
    locator: { path: eventsDbPath, ...(row.msgId === null ? {} : { msgId: row.msgId }) },
    initiative: null,
    category: classifyQuestion({ header: '', question, options: [] }),
    header: null,
    question,
    options: [],
    recommended: null,
    answer: row.answer,
    outcome: 'redirect',
  };
}

/** One cursor over the events table; its offset is the last answer event id read. */
export function queueSource(eventsDbPath: string): LedgerSource {
  return {
    name: QUEUE_SOURCE,
    async read(since: SourceWatermarks): Promise<SourceRead> {
      const out: SourceRead = { candidates: [], watermarks: new Map(), pending: 0, errors: [] };
      if (!existsSync(eventsDbPath)) return out;
      const answers = readAnswers(eventsDbPath, since.get(CURSOR)?.offset ?? 0);
      out.candidates = answers.map((row) => ({ row: queueRow(eventsDbPath, row), cwd: null }));
      const last = answers.at(-1);
      if (last !== undefined) out.watermarks.set(CURSOR, { offset: last.id, prefixHash: null });
      return out;
    },
  };
}
