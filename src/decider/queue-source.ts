import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  classifyQuestion,
  type InitiativeResolver,
  type SourceCandidate,
  type LedgerRowWire,
  type LedgerSource,
  type SourceRead,
  type SourceWatermarks,
} from '@titan-design/decider';
import { listInitiativeSlugs } from '../commands/_open-helpers.js';

/**
 * Precedents from agent-chat's human queue: each `answer` event paired with
 * the `question` it answers (`answer.ref` is the question's `msg_id`). Read
 * directly from `events.db`, read-only, under the same temporary coupling as
 * `session-index/origin-agent-chat.ts`, until TP-699 moves this source out of
 * active-work.
 *
 * Each answer takes its initiative from the question's `meta.initiative`, else
 * the one initiative that files its `meta.task`, else the asker's cwd from its
 * latest registration before the question. The cwd rides along either way so
 * the human-only cwd check still sees it.
 */

export const QUEUE_SOURCE = 'queue';
const CURSOR = 'events';
const TASK_ID = /^[A-Z][A-Z0-9]*-\d+$/;

export interface QueueSourceOptions {
  activeRoot: string;
  resolveInitiative: InitiativeResolver;
}

interface AnswerRow {
  id: number;
  ts: number;
  msgId: string | null;
  question: string | null;
  answer: string | null;
  meta: string | null;
  askerCwd: string | null;
}

interface AskMeta {
  initiative?: unknown;
  task?: unknown;
}

function readAnswers(eventsDbPath: string, afterId: number): AnswerRow[] {
  const db = new Database(eventsDbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT a.id AS id, a.ts AS ts, a.msg_id AS msgId, q.body AS question, a.body AS answer,
                q.meta AS meta,
                (SELECT json_extract(r.meta, '$.cwd') FROM events r
                  WHERE r.kind = 'registered' AND r.actor = q.actor AND r.id < q.id
                  ORDER BY r.id DESC LIMIT 1) AS askerCwd
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

function parseMeta(meta: string | null): AskMeta {
  if (meta === null) return {};
  try {
    const parsed: unknown = JSON.parse(meta);
    return typeof parsed === 'object' && parsed !== null ? (parsed as AskMeta) : {};
  } catch {
    return {};
  }
}

/** Task ids repeat across initiatives, so only an id filed in exactly one resolves. */
function initiativeForTask(activeRoot: string, slugs: string[], task: unknown): string | null {
  if (typeof task !== 'string' || !TASK_ID.test(task)) return null;
  const owners = slugs.filter((slug) =>
    existsSync(path.join(activeRoot, slug, 'tasks', `${task}.yml`)),
  );
  return owners.length === 1 ? owners[0] : null;
}

async function resolveAsk(
  options: QueueSourceOptions,
  slugs: string[],
  row: AnswerRow,
): Promise<string | null> {
  const meta = parseMeta(row.meta);
  if (typeof meta.initiative === 'string' && slugs.includes(meta.initiative))
    return meta.initiative;
  return (
    initiativeForTask(options.activeRoot, slugs, meta.task) ??
    (await options.resolveInitiative(row.askerCwd))
  );
}

function queueRow(eventsDbPath: string, row: AnswerRow, initiative: string | null): LedgerRowWire {
  const question = row.question ?? '';
  return {
    key: `queue:${row.id}`,
    v: 2,
    source: 'queue',
    asked_at: new Date(row.ts).toISOString(),
    locator: { path: eventsDbPath, ...(row.msgId === null ? {} : { msgId: row.msgId }) },
    initiative,
    category: classifyQuestion({ header: '', question, options: [] }),
    header: null,
    question,
    options: [],
    recommended: null,
    answer: row.answer,
    outcome: 'redirect',
  };
}

async function queueCandidates(
  eventsDbPath: string,
  options: QueueSourceOptions,
  answers: AnswerRow[],
): Promise<SourceCandidate[]> {
  const slugs = await listInitiativeSlugs(options.activeRoot);
  const candidates: SourceCandidate[] = [];
  for (const row of answers) {
    const initiative = await resolveAsk(options, slugs, row);
    candidates.push({ row: queueRow(eventsDbPath, row, initiative), cwd: row.askerCwd });
  }
  return candidates;
}

/** One cursor over the events table; its offset is the last answer event id read. */
export function queueSource(eventsDbPath: string, options: QueueSourceOptions): LedgerSource {
  return {
    name: QUEUE_SOURCE,
    async read(since: SourceWatermarks): Promise<SourceRead> {
      const out: SourceRead = { candidates: [], watermarks: new Map(), pending: 0, errors: [] };
      if (!existsSync(eventsDbPath)) return out;
      const answers = readAnswers(eventsDbPath, since.get(CURSOR)?.offset ?? 0);
      out.candidates = await queueCandidates(eventsDbPath, options, answers);
      const last = answers.at(-1);
      if (last !== undefined) out.watermarks.set(CURSOR, { offset: last.id, prefixHash: null });
      return out;
    },
  };
}
