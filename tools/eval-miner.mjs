#!/usr/bin/env node
/* eslint-disable no-undef -- Node ESM build tool */
/**
 * eval-miner.mjs — scores mine-session-signals against ground truth so we can
 * trust every capability built on top of it (cost rollups, indexes, views).
 *
 * Five checks, emitted as a scorecard:
 *   1. Ground-truth precision/coverage vs gh/git — PRs, branches, files.
 *      precision = reported ∩ truth / reported (are the miner's claims real?);
 *      coverage  = reported ∩ truth / truth (session-scoped — the miner only
 *      sees assets a session touched, so coverage is informational, not a gate).
 *   2. Determinism — mine twice, hash both, require an exact match.
 *   3. Performance — full mine under a ceiling (default 30s).
 *   4. Coverage % — the coverage figures from check 1, summarized.
 *   5. LLM-item accuracy — N/A until a deterministic-downstream LLM field exists
 *      (see AW-30); reported as skipped, never silently passed.
 *
 * Hard gates (non-zero exit): determinism, performance, and per-asset precision
 * ≥ threshold. Coverage is reported but never gates. Exit code makes it a local
 * pre-merge gate; the pure scoring fns below are unit-tested in CI (the full run
 * needs the operator's private ~/.claude transcripts, which CI does not have).
 *
 * Usage: node eval-miner.mjs [--repo <path>] [--min-precision 0.9] [--max-ms 30000] [--json] [--out file.json]
 */
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

// ── pure scoring (exported for unit tests) ───────────────────────────────────

/** precision = reported∩truth / reported; coverage = reported∩truth / truth. */
export function score(reported, truth) {
  const r = new Set(reported.map(String));
  const t = new Set(truth.map(String));
  let hit = 0;
  for (const x of r) if (t.has(x)) hit++;
  return {
    reported: r.size,
    truth: t.size,
    hits: hit,
    precision: r.size ? round(hit / r.size) : 1,
    coverage: t.size ? round(hit / t.size) : 1,
    missesFromReported: [...r].filter((x) => !t.has(x)).slice(0, 20),
  };
}

/** Fraction of intersecting PRs whose branch AND merged flag match ground truth. */
export function attrAccuracy(minerPrs, truthByNumber) {
  const shared = minerPrs.filter((p) => truthByNumber.has(String(p.number)));
  if (!shared.length) return { checked: 0, accurate: 0, accuracy: 1 };
  let ok = 0;
  for (const p of shared) {
    const g = truthByNumber.get(String(p.number));
    if ((p.branch || '') === g.branch && Boolean(p.merged) === g.merged) ok++;
  }
  return { checked: shared.length, accurate: ok, accuracy: round(ok / shared.length) };
}

export const round = (n) => Math.round(n * 1e4) / 1e4;

// ── ground truth (impure) ────────────────────────────────────────────────────

async function tryExec(cmd, argv, cwd) {
  try {
    const { stdout } = await pexec(cmd, argv, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, error: e.shortMessage || e.message };
  }
}

async function ghPrs(repo) {
  const r = await tryExec('gh', ['pr', 'list', '--state', 'all', '--json', 'number,headRefName,state,mergedAt', '-L', '1000'], repo);
  if (!r.ok) return { available: false, reason: r.error, byNumber: new Map(), numbers: [] };
  const byNumber = new Map();
  for (const pr of JSON.parse(r.stdout))
    byNumber.set(String(pr.number), { branch: pr.headRefName, merged: Boolean(pr.mergedAt) });
  return { available: true, byNumber, numbers: [...byNumber.keys()] };
}

async function gitBranches(repo, prBranches) {
  const r = await tryExec('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], repo);
  const live = r.ok ? r.stdout.split('\n').map((s) => s.replace(/^origin\//, '').trim()).filter((s) => s && s !== 'origin' && s !== 'HEAD') : [];
  return new Set([...live, ...prBranches]); // union: merged-then-deleted branches still count as real
}

async function gitFiles(repo) {
  // Truth = ever-in-history ∪ currently-tracked ∪ untracked-not-ignored, so a
  // real file the miner saw isn't a false miss just because it's uncommitted.
  const runs = await Promise.all([
    tryExec('git', ['log', '--all', '--name-only', '--pretty=format:'], repo),
    tryExec('git', ['ls-files'], repo),
    tryExec('git', ['ls-files', '--others', '--exclude-standard'], repo),
  ]);
  const files = new Set();
  for (const r of runs)
    if (r.ok) for (const line of r.stdout.split('\n')) { const s = line.trim(); if (s) files.add(s); }
  return files;
}

// ── mining ───────────────────────────────────────────────────────────────────

async function loadSignals(file) {
  const raw = await fs.readFile(file, 'utf8');
  const start = raw.indexOf('{', raw.indexOf('export const sessionSignals ='));
  const end = raw.indexOf('} as const;', start);
  return JSON.parse(raw.slice(start, end + 1));
}

async function mine(repo, env) {
  const out = path.join(os.tmpdir(), `aw-eval-${path.basename(repo)}-${process.pid}-${Number(process.hrtime.bigint() % 100000n)}.ts`);
  const t0 = process.hrtime.bigint();
  await pexec('node', [path.join(here, 'mine-session-signals.mjs'), '--repo', repo, '--out', out], { maxBuffer: 64 * 1024 * 1024, env: env || process.env });
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const raw = await fs.readFile(out, 'utf8');
  const start = raw.indexOf('{', raw.indexOf('export const sessionSignals ='));
  const end = raw.indexOf('} as const;', start);
  const body = raw.slice(start, end + 1);
  await fs.unlink(out).catch(() => {});
  return { signals: JSON.parse(body), elapsedMs: round(elapsedMs), hash: createHash('sha256').update(body).digest('hex') };
}

/**
 * Determinism must be tested on FROZEN input: mining the live corpus twice fails
 * spuriously because the operator's own in-flight session transcript grows
 * between runs. Snapshot the exact transcripts into a temp HOME, mine that twice.
 */
async function determinismCheck(repo, transcripts) {
  const home = os.homedir();
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-home-'));
  try {
    for (const t of transcripts) {
      const abs = t.startsWith('~') ? path.join(home, t.slice(1)) : t;
      const dest = path.join(tmpHome, path.relative(home, abs));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(abs, dest);
    }
    const env = { ...process.env, HOME: tmpHome };
    const a = await mine(repo, env);
    const b = await mine(repo, env);
    return { firstHash: a.hash, secondHash: b.hash, identical: a.hash === b.hash, frozenTranscripts: transcripts.length };
  } finally {
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
}

// ── orchestration ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { repo: process.cwd(), minPrecision: 0.9, maxMs: 30000, json: false, out: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo') a.repo = path.resolve(argv[++i]);
    else if (k === '--min-precision') a.minPrecision = Number(argv[++i]);
    else if (k === '--max-ms') a.maxMs = Number(argv[++i]);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--json') a.json = true;
  }
  return a;
}

async function evaluate(args) {
  const first = await mine(args.repo);
  const second = await mine(args.repo);
  const s = first.signals;

  const prs = await ghPrs(args.repo);
  const branchTruth = await gitBranches(args.repo, [...prs.byNumber.values()].map((v) => v.branch).filter(Boolean));
  const fileTruth = await gitFiles(args.repo);

  const checks = {
    prPrecision: prs.available ? score(s.prs.map((p) => p.number), prs.numbers) : { skipped: prs.reason },
    prAttr: prs.available ? attrAccuracy(s.prs, prs.byNumber) : { skipped: prs.reason },
    branchPrecision: score((s.branches || []).map((b) => b.name), [...branchTruth]),
    filePrecision: score((s.files || []).map((f) => f.path), [...fileTruth]),
    determinism: await determinismCheck(args.repo, s.transcripts || []),
    performance: { elapsedMs: first.elapsedMs, ceilingMs: args.maxMs, underCeiling: first.elapsedMs <= args.maxMs, incremental: 'n/a — no incremental mode yet (AW-23)' },
    llmAccuracy: { skipped: 'no LLM-derived fields in the deterministic miner (see AW-30)' },
  };

  // Branch precision is REPORTED, not hard-gated: worktree/cross-repo branches
  // the miner correctly attributes aren't in this repo's git, so its "misses"
  // conflate real miner junk with legitimate cross-repo attribution. PRs and
  // files have durable, repo-scoped ground truth and are hard gates.
  const gates = [
    ['determinism', checks.determinism.identical],
    ['performance', checks.performance.underCeiling],
    ['pr-precision', checks.prPrecision.skipped ? true : checks.prPrecision.precision >= args.minPrecision],
    ['file-precision', checks.filePrecision.precision >= args.minPrecision],
  ];
  checks.branchPrecision.belowThreshold = checks.branchPrecision.precision < args.minPrecision;
  return {
    repo: s.repo,
    minerVersion: s.generatedFrom,
    minPrecision: args.minPrecision,
    checks,
    gates: Object.fromEntries(gates),
    pass: gates.every(([, ok]) => ok),
  };
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;

function printScorecard(r) {
  console.log(`eval-miner scorecard — ${r.repo}\n`);
  const row = (label, c) =>
    c.skipped
      ? console.log(`  ${label.padEnd(18)} skipped — ${c.skipped}`)
      : console.log(`  ${label.padEnd(18)} precision ${pct(c.precision).padStart(7)}  coverage ${pct(c.coverage).padStart(7)}  (${c.hits}/${c.reported} real, ${c.truth} in truth)`);
  row('PRs (gate)', r.checks.prPrecision);
  row('files (gate)', r.checks.filePrecision);
  row('branches (rpt)', r.checks.branchPrecision);
  if (r.checks.branchPrecision.belowThreshold)
    console.log(`  ${''.padEnd(18)} ⚠ reported branches not in git/gh truth (miner junk or cross-repo): ${r.checks.branchPrecision.missesFromReported.join(', ')}`);
  if (!r.checks.prAttr.skipped)
    console.log(`  ${'pr-attributes'.padEnd(18)} ${pct(r.checks.prAttr.accuracy)} branch+merged match (${r.checks.prAttr.accurate}/${r.checks.prAttr.checked})`);
  const d = r.checks.determinism;
  console.log(`  ${'determinism'.padEnd(18)} ${d.identical ? 'PASS' : 'FAIL'} — ${d.frozenTranscripts} frozen transcripts, ${d.identical ? 'identical hash' : 'hashes differ'}`);
  const p = r.checks.performance;
  console.log(`  ${'performance'.padEnd(18)} ${p.elapsedMs}ms / ${p.ceilingMs}ms ceiling — ${p.underCeiling ? 'PASS' : 'FAIL'}`);
  console.log(`  ${'llm-accuracy'.padEnd(18)} skipped — ${r.checks.llmAccuracy.skipped}`);
  console.log(`\ngates: ${Object.entries(r.gates).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join('  ')}`);
  console.log(`\n${r.pass ? '✅ PASS' : '❌ FAIL'} (min precision ${pct(r.minPrecision)})`);
}

async function main() {
  const args = parseArgs(process.argv);
  const report = await evaluate(args);
  if (args.out) await fs.writeFile(args.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printScorecard(report);
  process.exit(report.pass ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.stack || String(e));
    process.exit(2);
  });
}
