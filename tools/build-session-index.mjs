#!/usr/bin/env node
/* eslint-disable no-undef -- Node ESM build tool */
/**
 * build-session-index.mjs — manual rebuild of the session graph
 * (`<minerRoot>/graph.sqlite3`).
 *
 * A thin argv wrapper over `runRefresh`, which is the same function behind
 * `active-work miner refresh` and the daemon's transcript watcher — the three
 * surfaces deliberately share one code path so discovery, quarantine and
 * rollup semantics cannot drift apart.
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

const { openGraph } = await import(src('session-index/graph.ts'));
const { runRefresh, withRefreshLock } = await import(src('session-index/refresh.ts'));

function parseArgs(argv) {
  const args = { db: null, full: false, limit: undefined, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i];
    else if (argv[i] === '--full') args.full = true;
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

const args = parseArgs(process.argv);
const graph = openGraph(args.db ?? undefined);
const summary = await withRefreshLock(() =>
  runRefresh({ graph, full: args.full, limit: args.limit }),
);

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `transcripts ${summary.transcripts} · facts +${summary.factsAdded} · ` +
      `indexed ${summary.indexed} · rewound ${summary.rewound} · ` +
      `unchanged ${summary.unchanged} · quarantined ${summary.quarantined} · ` +
      `missing ${summary.missing} · turns rolled up ${summary.turnsRolledUp} · ` +
      `${summary.durationMs}ms`,
  );
  for (const error of summary.errors) console.log(`  ! ${error}`);
  console.log(
    'counts →',
    ['session', 'fact', 'edge', 'file', 'pr', 'branch', 'task']
      .map((t) => `${t} ${graph.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n}`)
      .join(' · '),
  );
}
graph.db.close();
