#!/usr/bin/env node
/* eslint-disable no-undef -- Node ESM build tool */
/**
 * mine-drain.mjs — run the AW-28 Drain miner over the transcript corpus,
 * filling `<minerRoot>/templates.yml` and `occurrences.jsonl`.
 *
 * A thin argv wrapper over `runDrainIngest`, the same function behind
 * `active-work miner drain-ingest`, so the script and the command cannot drift
 * (the `build-session-index.mjs` / `miner refresh` precedent).
 *
 * Not to be confused with `mine-session-signals.mjs` (the AW-22 signal
 * prototype) or `build-session-index.mjs` (the AW-23 SQLite index): this fills
 * the error/tool-result *template* store, which shares no rows with either.
 *
 * Usage: node mine-drain.mjs [--root <dir>] [--corpus <dir>] [--full]
 *                            [--limit N] [--chunk-bytes N] [--verify-hashes] [--json]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => new URL(`file://${path.join(here, '..', 'src', rel)}`).href;

const { runDrainIngest } = await import(src('miner/transcript-reader.ts'));

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--root') args.root = argv[++i];
    else if (key === '--corpus') args.corpusRoot = argv[++i];
    else if (key === '--full') args.full = true;
    else if (key === '--limit') args.limit = Number(argv[++i]);
    else if (key === '--chunk-bytes') args.chunkBytes = Number(argv[++i]);
    else if (key === '--verify-hashes') args.verifyHashes = true;
    else if (key === '--json') args.json = true;
  }
  return args;
}

const { json, ...options } = parseArgs(process.argv);
const summary = await runDrainIngest(options);

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `transcripts ${summary.transcripts} · scanned ${summary.scanned} · ` +
      `unchanged ${summary.unchanged} · rewound ${summary.rewound} · ` +
      `lines ${summary.linesRead} (${summary.malformedLines} malformed) · ` +
      `blobs ${summary.blobs} → ingested ${summary.ingested} · ` +
      `templates ${summary.templates} (+${summary.newTemplates}) · ` +
      `${Math.round(summary.durationMs)}ms`,
  );
  for (const error of summary.errors.slice(0, 10)) console.log(`  ! ${error}`);
  if (summary.errors.length > 10) console.log(`  ... ${summary.errors.length - 10} more`);
}
