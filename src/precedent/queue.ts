import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { classifyQuestion } from './classify.js';
import type { PrecedentRow } from './schema.js';

/**
 * Precedents from agent-chat's human queue: each `answer` event paired with
 * the `question` it answers (`answer.ref` is the question's `msg_id`). Read
 * directly from `events.db`, read-only, under the same temporary coupling as
 * `session-index/origin-agent-chat.ts`.
 */

interface AnswerRow {
  id: number;
  ts: number;
  question: string | null;
  answer: string | null;
}

export function extractQueueRows(eventsDbPath: string): PrecedentRow[] {
  if (!existsSync(eventsDbPath)) return [];
  const db = new Database(eventsDbPath, { readonly: true, fileMustExist: true });
  try {
    const answers = db
      .prepare(
        `SELECT a.id AS id, a.ts AS ts, q.body AS question, a.body AS answer
           FROM events a
           JOIN events q ON q.msg_id = a.ref AND q.kind = 'question'
          WHERE a.kind = 'answer'
          ORDER BY a.id`,
      )
      .all() as AnswerRow[];
    return answers.map(queueRow);
  } finally {
    db.close();
  }
}

function queueRow(row: AnswerRow): PrecedentRow {
  const question = row.question ?? '';
  return {
    key: `queue:${row.id}`,
    source: 'queue',
    asked_at: new Date(row.ts).toISOString(),
    session_id: null,
    tool_use_id: null,
    initiative: null,
    class: classifyQuestion({ header: '', question, options: [] }),
    header: null,
    question,
    options: [],
    recommended: null,
    answer: row.answer,
    pick_type: 'free_text',
    free_text: row.answer,
  };
}
