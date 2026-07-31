#!/usr/bin/env node
/* eslint-disable no-undef -- Node ESM build tool */
/**
 * eval-drain.mjs — scores the AW-28/AW-89 Drain template miner over the real
 * `~/.claude/projects` corpus, so anything built on `templates.yml` rests on a
 * measured clustering rather than an assumed one.
 *
 * Sibling of `tools/eval-miner.mjs` (AW-22 signal prototype) and
 * `tools/eval-session-index.mjs` (AW-23 SQLite index); those score different
 * subsystems and are deliberately left alone. Only the shared `round` helper
 * is reused, so "coverage" means the same thing in all three scorecards.
 *
 * Five checks:
 *   1. Coverage — of the eligible blobs found (tool errors + command
 *      stdout/stderr), what fraction clustered rather than being skipped, plus
 *      the transcript-line parse rate underneath it. Both gate: a miner that
 *      silently drops a tenth of the corpus is worse than one that fails.
 *   2. Template stability — new-template rate sampled through a single pass and
 *      split by blobs seen. Must *decay*: a rate that stays flat means Drain is
 *      minting a template per blob and clustering nothing. Reported as a curve,
 *      and gated on the second half's rate against the first's.
 *   3. Determinism — two independent full runs over a frozen corpus copy must
 *      produce byte-identical `templates.yml`.
 *   4. Incremental idempotency — replaying a growing corpus in slices must
 *      produce the same template-id set as one all-at-once pass. This is the
 *      direct test of the warm-restart fidelity gap AW-28 documented and AW-89
 *      closed with `drain-trees.json`: before the snapshot, a warm start
 *      re-seeded its trees from first-seen (un-generalized) template tokens and
 *      this diverged by ~6%. A separate, non-gating `reordering` figure shows
 *      what happens when chunk boundaries also permute the blob order, which
 *      Drain cannot be idempotent under by construction.
 *   5. False merges — for a sample of clusters, re-derive each occurrence's
 *      masked signature from its locator and check the cluster is internally
 *      similar. A cluster spanning several error *classes* is an over-eager
 *      merge and is flagged (reported, not gated: some are legitimately
 *      `unknown`-classed).
 *
 * Exit code makes this a local pre-merge gate. The pure functions below are
 * unit-tested in CI; the full run needs the operator's private ~/.claude
 * corpus, which CI does not have.
 *
 * Usage:
 *   node eval-drain.mjs [--corpus <dir>] [--limit N] [--sample-every 500]
 *                       [--freeze-limit 300] [--chunk-bytes 250000] [--slices 4]
 *                       [--sample 40] [--min-coverage 0.99]
 *                       [--max-stability-ratio 1.0] [--max-divergence 0.01] [--json] [--out f.json]
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register();
const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => new URL(`file://${path.join(here, '..', 'src', rel)}`).href;

const { runDrainIngest } = await import(src('miner/transcript-reader.ts'));
const { loadTemplates, readOccurrences } = await import(src('miner/store.ts'));
const { loadReaderState } = await import(src('miner/reader-state.ts'));
const { extractSignature } = await import(src('miner/signature.ts'));
const { applyMasks } = await import(src('miner/masks.ts'));
const { extractBlobs } = await import(src('miner/blob-extract.ts'));
const { discoverTranscripts, transcriptsRoot } = await import(
  src('miner/session-index/discover.ts')
);

export { round } from './eval-miner.mjs';
import { round } from './eval-miner.mjs';

// ── pure scoring (exported for unit tests) ───────────────────────────────────

/**
 * Coverage of the ingest funnel: lines that parsed, and eligible blobs that
 * clustered. Kept separate because they fail for different reasons — a corrupt
 * transcript loses lines, a mask/signature crash loses blobs.
 */
export function coverage(summary) {
  const lines = summary.linesRead;
  const blobs = summary.blobs;
  return {
    linesRead: lines,
    malformedLines: summary.malformedLines,
    lineParseRate: lines ? round((lines - summary.malformedLines) / lines) : 1,
    blobs,
    ingested: summary.ingested,
    skipped: blobs - summary.ingested,
    blobCoverage: blobs ? round(summary.ingested / blobs) : 1,
  };
}

/**
 * New-template rate over equal-sized halves of the blob stream.
 *
 * `samples` are cumulative `(blobs, templates, evicting)` points from a single
 * ingest pass, so the split is by *blobs seen*, not by transcript: transcripts
 * differ in blob count by two orders of magnitude, and slicing by them measures
 * transcript size rather than clustering behaviour.
 *
 * The gated `ratio` — second half's marginal rate over the first half's — is
 * computed only over samples taken BEFORE any Drain partition hit its LRU cap.
 * Past that point a new cluster evicts an old one, so a re-occurrence of an
 * evicted shape mints a fresh template and the rate rises again by
 * construction. That is a capacity finding, not a clustering-quality one, so it
 * is reported separately as `postEviction` rather than folded into the gate.
 */
export function stabilityCurve(samples) {
  const usable = samples.filter((s) => !s.evicting);
  const evictionAt = samples.find((s) => s.evicting)?.blobs ?? null;
  const withRate = samples.map((s) => ({ ...s, rate: s.blobs ? round(s.templates / s.blobs) : 0 }));
  if (usable.length < 2) {
    return { samples: withRate, evictionAt, firstRate: 0, lastRate: 0, ratio: 1, gatedOn: 0 };
  }

  const last = usable.at(-1);
  const mid =
    usable.find((s) => s.blobs >= last.blobs / 2) ?? usable[Math.floor(usable.length / 2)];
  const firstRate = mid.blobs ? round(mid.templates / mid.blobs) : 0;
  const tailBlobs = last.blobs - mid.blobs;
  const lastRate = tailBlobs ? round((last.templates - mid.templates) / tailBlobs) : 0;

  const total = samples.at(-1);
  return {
    samples: withRate,
    evictionAt,
    gatedOn: last.blobs,
    splitAtBlobs: mid.blobs,
    firstRate,
    lastRate,
    ratio: firstRate ? round(lastRate / firstRate) : 1,
    postEviction:
      evictionAt === null
        ? null
        : {
            blobs: total.blobs - last.blobs,
            newTemplates: total.templates - last.templates,
            rate:
              total.blobs > last.blobs
                ? round((total.templates - last.templates) / (total.blobs - last.blobs))
                : 0,
          },
  };
}

/** Symmetric difference of two id sets, with a bounded sample of each side. */
export function compareSets(a, b, sampleSize = 10) {
  const left = new Set(a);
  const right = new Set(b);
  const onlyLeft = [...left].filter((x) => !right.has(x));
  const onlyRight = [...right].filter((x) => !left.has(x));
  return {
    leftSize: left.size,
    rightSize: right.size,
    identical: onlyLeft.length === 0 && onlyRight.length === 0,
    onlyLeft: onlyLeft.slice(0, sampleSize),
    onlyRight: onlyRight.slice(0, sampleSize),
    divergence: round((onlyLeft.length + onlyRight.length) / Math.max(1, left.size + right.size)),
  };
}

/**
 * Internal similarity of one cluster, from its members' masked signatures.
 *
 * Several distinct masked signatures in a cluster is normal and is the point
 * of Drain — they differ only where a token got wildcarded. Several distinct
 * *error classes* is not: `TypeError` and `ENOENT` landing in one cluster
 * means the shared shape was an artifact, not a real similarity.
 */
export function clusterDiversity(members) {
  const signatures = new Set(members.map((m) => m.maskedSignature));
  const errorClasses = new Set(members.map((m) => m.errorClass));
  return {
    members: members.length,
    distinctSignatures: signatures.size,
    distinctErrorClasses: errorClasses.size,
    errorClasses: [...errorClasses].slice(0, 6),
    signatureDiversity: members.length ? round(signatures.size / members.length) : 0,
    suspicious: errorClasses.size > 1,
  };
}

// ── corpus helpers (impure) ──────────────────────────────────────────────────

const tmpRoot = () => fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-drain-'));

async function hashFile(file) {
  try {
    return createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex');
  } catch {
    return null;
  }
}

/**
 * Determinism and idempotency must run on FROZEN input: the operator's own
 * in-flight transcript grows between passes, so comparing two runs over the
 * live corpus fails spuriously. Copies a bounded slice into a temp corpus.
 */
async function freezeCorpus(corpusRoot, limit) {
  const dest = await tmpRoot();
  const discovered = (await discoverTranscripts(corpusRoot)).slice(0, limit);
  for (const transcript of discovered) {
    const target = path.join(dest, transcript.projectDir, path.basename(transcript.absolutePath));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(transcript.absolutePath, target);
  }
  return { dest, transcripts: discovered.length };
}

/**
 * Growing-corpus replay: process the first quarter of the corpus, then the
 * first half, and so on. This is the incremental pattern production actually
 * has — transcripts arrive over time, and each pass warm-starts on the store
 * the previous one left. Blob ORDER is identical to a single pass, so any
 * divergence is warm-restart infidelity and nothing else.
 */
async function slicedRun(corpusRoot, root, slices) {
  const total = (await discoverTranscripts(corpusRoot)).length;
  let passes = 0;
  for (let k = 1; k <= slices; k++) {
    await runDrainIngest({ root, corpusRoot, limit: Math.max(1, Math.round((total * k) / slices)) });
    passes++;
  }
  return { passes };
}

/**
 * Interleaved replay: repeat small-byte-budget passes until every transcript
 * is at its watermark. Reported, never gated.
 *
 * This deliberately *reorders* the blob stream — pass 1 takes the head of every
 * transcript, pass 2 the next chunk of every transcript — where a single pass
 * drains each transcript in turn. Drain is an online algorithm whose clusters
 * depend on arrival order, so a difference here is expected and says nothing
 * about the reader. It is measured anyway, as an honest upper bound on how much
 * the clustering can move under adversarial re-ordering.
 */
async function chunkedRun(corpusRoot, root, chunkBytes, maxPasses = 200) {
  let passes = 0;
  for (;;) {
    const summary = await runDrainIngest({ root, corpusRoot, chunkBytes });
    passes++;
    if (summary.scanned === 0) return { passes, completed: true };
    if (passes >= maxPasses) return { passes, completed: false };
  }
}

async function templateIds(root) {
  return (await loadTemplates(root)).map((t) => t.templateId).sort();
}

// ── false-merge spot check ───────────────────────────────────────────────────

/** Re-read the exact JSONL line a locator points at. */
async function readLocatorLine(paths, locator) {
  const [transcriptIndex, byteOffset, byteLength] = locator;
  const stored = paths[transcriptIndex];
  if (!stored) return null;
  const absolute = stored.startsWith('~') ? path.join(os.homedir(), stored.slice(1)) : stored;
  const handle = await fs.open(absolute, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(byteLength);
    await handle.read(buffer, 0, byteLength, byteOffset);
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Group occurrence locators by template, keeping at most `cap` per template. */
async function occurrencesByTemplate(root, wanted, cap) {
  const byTemplate = new Map();
  for await (const occurrence of readOccurrences(root)) {
    if (!wanted.has(occurrence.templateId)) continue;
    const list = byTemplate.get(occurrence.templateId) ?? [];
    if (list.length < cap) list.push(occurrence.locator);
    byTemplate.set(occurrence.templateId, list);
  }
  return byTemplate;
}

/**
 * Sample the largest clusters — the ones an over-eager merge would produce, and
 * the ones whose mis-clustering would cost the most downstream.
 */
async function falseMergeCheck(root, sampleSize, perCluster = 25) {
  const templates = await loadTemplates(root);
  const sample = [...templates].sort((a, b) => b.occurrenceCount - a.occurrenceCount).slice(0, sampleSize);
  const wanted = new Set(sample.map((t) => t.templateId));
  const locators = await occurrencesByTemplate(root, wanted, perCluster);
  const paths = (await loadReaderState(root)).transcripts.map((t) => t.path);

  const clusters = [];
  for (const template of sample) {
    const members = [];
    for (const locator of locators.get(template.templateId) ?? []) {
      const line = await readLocatorLine(paths, locator);
      if (!line) continue;
      for (const blob of extractBlobs(line, new Map())) {
        const signature = extractSignature(template.toolType, blob.rawText);
        members.push({
          errorClass: signature.errorClass,
          maskedSignature: applyMasks(template.toolType, signature.signatureLine).maskedSignature,
        });
      }
    }
    if (members.length > 0) {
      clusters.push({
        templateId: template.templateId.slice(0, 12),
        toolType: template.toolType,
        occurrenceCount: template.occurrenceCount,
        maskedSignature: template.maskedSignature.slice(0, 90),
        ...clusterDiversity(members),
      });
    }
  }
  const suspicious = clusters.filter((c) => c.suspicious);
  return {
    sampled: clusters.length,
    suspicious: suspicious.length,
    suspiciousRate: clusters.length ? round(suspicious.length / clusters.length) : 0,
    worst: suspicious.slice(0, 5),
  };
}

// ── orchestration ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = {
    corpus: transcriptsRoot(),
    limit: undefined,
    sampleEvery: 500,
    freezeLimit: 300,
    chunkBytes: 250_000,
    sample: 40,
    minCoverage: 0.99,
    maxStabilityRatio: 1.0,
    maxDivergence: 0.01,
    slices: 4,
    json: false,
    out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--corpus') a.corpus = path.resolve(argv[++i]);
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--sample-every') a.sampleEvery = Number(argv[++i]);
    else if (k === '--freeze-limit') a.freezeLimit = Number(argv[++i]);
    else if (k === '--chunk-bytes') a.chunkBytes = Number(argv[++i]);
    else if (k === '--sample') a.sample = Number(argv[++i]);
    else if (k === '--min-coverage') a.minCoverage = Number(argv[++i]);
    else if (k === '--max-stability-ratio') a.maxStabilityRatio = Number(argv[++i]);
    else if (k === '--max-divergence') a.maxDivergence = Number(argv[++i]);
    else if (k === '--slices') a.slices = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--json') a.json = true;
  }
  return a;
}

async function evaluate(args) {
  const fullRoot = await tmpRoot();
  const full = await runDrainIngest({
    root: fullRoot,
    corpusRoot: args.corpus,
    limit: args.limit,
    sampleEvery: args.sampleEvery,
  });

  const frozen = await freezeCorpus(args.corpus, args.freezeLimit);
  const [detA, detB] = [await tmpRoot(), await tmpRoot()];
  await runDrainIngest({ root: detA, corpusRoot: frozen.dest });
  await runDrainIngest({ root: detB, corpusRoot: frozen.dest });

  const sliceRoot = await tmpRoot();
  const sliced = await slicedRun(frozen.dest, sliceRoot, args.slices);
  const chunkRoot = await tmpRoot();
  const chunked = await chunkedRun(frozen.dest, chunkRoot, args.chunkBytes);
  const baseline = await templateIds(detA);

  const checks = {
    coverage: coverage(full),
    stability: stabilityCurve(full.curve),
    determinism: {
      frozenTranscripts: frozen.transcripts,
      firstHash: await hashFile(path.join(detA, 'templates.yml')),
      secondHash: await hashFile(path.join(detB, 'templates.yml')),
    },
    idempotency: {
      slices: sliced.passes,
      ...compareSets(baseline, await templateIds(sliceRoot)),
    },
    reordering: {
      chunkBytes: args.chunkBytes,
      passes: chunked.passes,
      completed: chunked.completed,
      ...compareSets(baseline, await templateIds(chunkRoot)),
    },
    falseMerge: await falseMergeCheck(fullRoot, args.sample),
  };
  checks.determinism.identical =
    checks.determinism.firstHash !== null &&
    checks.determinism.firstHash === checks.determinism.secondHash;

  const gates = [
    ['blob-coverage', checks.coverage.blobCoverage >= args.minCoverage],
    ['line-parse', checks.coverage.lineParseRate >= args.minCoverage],
    ['stability', checks.stability.ratio <= args.maxStabilityRatio],
    ['determinism', checks.determinism.identical],
    ['incremental-idempotency', checks.idempotency.divergence <= args.maxDivergence],
  ];

  for (const dir of [fullRoot, detA, detB, sliceRoot, chunkRoot, frozen.dest]) {
    await fs.rm(dir, { recursive: true, force: true });
  }

  return {
    corpus: args.corpus,
    transcripts: full.transcripts,
    templates: full.templates,
    thresholds: {
      minCoverage: args.minCoverage,
      maxStabilityRatio: args.maxStabilityRatio,
      maxDivergence: args.maxDivergence,
    },
    checks,
    gates: Object.fromEntries(gates),
    pass: gates.every(([, ok]) => ok),
  };
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;

function printScorecard(r) {
  console.log(`eval-drain scorecard — ${r.transcripts} transcripts, ${r.templates} templates\n`);
  const c = r.checks.coverage;
  console.log(
    `  ${'coverage (gate)'.padEnd(24)} blobs ${pct(c.blobCoverage)} (${c.ingested}/${c.blobs}, ${c.skipped} skipped) · ` +
      `lines ${pct(c.lineParseRate)} (${c.malformedLines} malformed of ${c.linesRead})`,
  );
  const s = r.checks.stability;
  console.log(
    `  ${'stability (gate)'.padEnd(24)} rate ${s.firstRate} → ${s.lastRate} (split @${s.splitAtBlobs} of ${s.gatedOn} pre-eviction blobs) · ratio ${s.ratio} (ceiling ${r.thresholds.maxStabilityRatio})`,
  );
  const step = Math.max(1, Math.ceil(s.samples.length / 8));
  for (const point of s.samples.filter((_, i) => i % step === 0 || i === s.samples.length - 1)) {
    console.log(
      `  ${''.padEnd(24)}   ${String(point.blobs).padStart(6)} blobs → ${String(point.templates).padStart(5)} templates (${point.rate}/blob)${point.evicting ? ' [evicting]' : ''}`,
    );
  }
  if (s.postEviction) {
    console.log(
      `  ${''.padEnd(24)}   ⚠ Drain LRU cap reached at ${s.evictionAt} blobs; the ${s.postEviction.blobs} blobs after it minted ${s.postEviction.newTemplates} templates (${s.postEviction.rate}/blob) — evicted shapes get re-minted, so template count keeps climbing`,
    );
  }
  const d = r.checks.determinism;
  console.log(
    `  ${'determinism (gate)'.padEnd(24)} ${d.identical ? 'PASS' : 'FAIL'} — ${d.frozenTranscripts} frozen transcripts, ${d.identical ? 'identical templates.yml' : 'hashes differ'}`,
  );
  const i = r.checks.idempotency;
  const idemOk = i.divergence <= r.thresholds.maxDivergence;
  console.log(
    `  ${'idempotency (gate)'.padEnd(24)} ${idemOk ? 'PASS' : 'FAIL'} — ${i.slices} growing-corpus passes vs one pass: ${i.leftSize} vs ${i.rightSize} templates, divergence ${pct(i.divergence)} (ceiling ${pct(r.thresholds.maxDivergence)})`,
  );
  if (!i.identical) {
    console.log(
      `  ${''.padEnd(24)}   note: residual divergence is LRU eviction order, not warm-restart routing (see src/miner/tree-store.ts)`,
    );
  }
  const o = r.checks.reordering;
  console.log(
    `  ${'reordering (rpt)'.padEnd(24)} ${o.passes} interleaved passes @${o.chunkBytes}B${o.completed ? '' : ' (capped)'} vs one pass: divergence ${pct(o.divergence)} — expected, Drain is order-dependent`,
  );
  const f = r.checks.falseMerge;
  console.log(
    `  ${'false-merge (rpt)'.padEnd(24)} ${f.suspicious}/${f.sampled} sampled clusters span >1 error class (${pct(f.suspiciousRate)})`,
  );
  for (const w of f.worst) {
    console.log(
      `  ${''.padEnd(24)}   ⚠ ${w.templateId} ${w.toolType} ×${w.occurrenceCount} classes=[${w.errorClasses.join('|')}] :: ${w.maskedSignature}`,
    );
  }
  console.log(
    `\ngates: ${Object.entries(r.gates)
      .map(([k, v]) => `${k}=${v ? '✓' : '✗'}`)
      .join('  ')}`,
  );
  console.log(`\n${r.pass ? '✅ PASS' : '❌ FAIL'}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const report = await evaluate(args);
  if (args.out) await fs.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printScorecard(report);
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.stack || String(e));
    process.exit(2);
  });
}
