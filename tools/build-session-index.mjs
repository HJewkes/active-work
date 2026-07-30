#!/usr/bin/env node
/* eslint-disable no-undef -- Node ESM build tool */
/**
 * build-session-index.mjs — manual full-corpus rebuild of the AW-23 session
 * signal index (`<minerRoot>/index.sqlite3`).
 *
 * Walks every `~/.claude/projects/ * / *.jsonl`, resumes each transcript from
 * its stored byte-offset watermark, and applies the extracted rows in one
 * transaction per transcript. Malformed transcripts are quarantined and the
 * run continues.
 *
 * Sibling of `tools/mine-session-signals.mjs` (the AW-22 prototype this
 * supersedes); unlike that tool it is cross-initiative — there is no `--repo`
 * flag, repo scoping is a query-time filter over `files.repo`/`prs.repo`.
 *
 * Usage: node build-session-index.mjs [--db <path>] [--full] [--limit N] [--json]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => new URL(`file://${path.join(here, '..', 'src', rel)}`).href;

const { discoverTranscripts } = await import(src('miner/session-index/discover.ts'));
const { openSessionIndex } = await import(src('miner/session-index/db.ts'));
const { indexTranscript } = await import(src('miner/session-index/quarantine.ts'));
const { resetIndex } = await import(src('miner/session-index/writer.ts'));

function parseArgs(argv) {
  const args = { db: null, full: false, limit: Infinity, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i];
    else if (argv[i] === '--full') args.full = true;
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function summarize(outcomes) {
  const counts = { indexed: 0, unchanged: 0, quarantined: 0, missing: 0 };
  let facts = 0;
  for (const outcome of outcomes) {
    counts[outcome.status]++;
    facts += outcome.factsAdded;
  }
  return { transcripts: outcomes.length, facts, ...counts };
}

const args = parseArgs(process.argv);
const db = openSessionIndex(args.db ?? undefined);
if (args.full) resetIndex(db);

const transcripts = (await discoverTranscripts()).slice(0, args.limit);
const outcomes = [];
for (const transcript of transcripts) {
  outcomes.push(await indexTranscript(db, transcript));
}

const summary = summarize(outcomes);
if (args.json) {
  console.log(JSON.stringify({ summary, outcomes }, null, 2));
} else {
  console.log(
    `transcripts ${summary.transcripts} · facts +${summary.facts} · ` +
      `indexed ${summary.indexed} · unchanged ${summary.unchanged} · ` +
      `quarantined ${summary.quarantined} · missing ${summary.missing}`,
  );
  for (const outcome of outcomes.filter((o) => o.reason))
    console.log(`  ! ${outcome.status}: ${outcome.path} — ${outcome.reason}`);
  console.log(
    'counts →',
    ['sessions', 'facts', 'edges', 'files', 'prs', 'branches', 'tasks']
      .map((t) => `${t} ${db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n}`)
      .join(' · '),
  );
}
db.close();
