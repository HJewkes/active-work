#!/usr/bin/env node
/* eslint-disable no-undef -- Node ESM build tool */
/**
 * cost-rollup.mjs — price a mine-session-signals output and roll token spend up
 * to each session, PR, and the whole initiative, per model.
 *
 * Pricing is a SEPARATE versioned table (tools/pricing/models.json) joined at
 * rollup time — token buckets are never priced at ingest, so re-pricing history
 * is a table edit, not a re-mine. Each session's tokensByModel{model→{in,out,
 * cacheRead,cacheCreation}} is priced per model; PR cost = sum over the PR's
 * contributing sessions; initiative cost = sum over all sessions (no double
 * count). Deterministic: same signals + same table in → same dollars out.
 *
 * Usage:
 *   node cost-rollup.mjs --signals <session-signals.ts|.json> [--pricing <models.json>] [--out file.ts] [--json]
 *   node cost-rollup.mjs --repo <absoluteRepoPath> [...]   # mines first, then prices
 *
 * Emits a typed TS module (default: ../data/cost-rollup.ts) and prints a summary.
 */
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const pexec = promisify(execFile);
const here = path.dirname(new URL(import.meta.url).pathname);

function parseArgs(argv) {
  const args = { signals: null, repo: null, pricing: path.join(here, 'pricing', 'models.json'), out: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--signals') args.signals = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--pricing') args.pricing = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

/** Parse a mine-session-signals output — `.json`, or the `export const sessionSignals = {…} as const;` TS wrapper. */
async function loadSignals(file) {
  const raw = await fs.readFile(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(raw);
  const start = raw.indexOf('{', raw.indexOf('export const sessionSignals ='));
  const end = raw.indexOf('} as const;', start);
  if (start < 0 || end < 0) throw new Error(`${file}: not a recognized session-signals module`);
  return JSON.parse(raw.slice(start, end + 1));
}

/** Mine a repo into a temp session-signals module, then load it. */
async function mineRepo(repo) {
  const out = path.join(os.tmpdir(), `aw-signals-${path.basename(repo)}.ts`);
  await pexec('node', [path.join(here, 'mine-session-signals.mjs'), '--repo', repo, '--out', out], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return loadSignals(out);
}

/** Collapse a raw model id to a base key: strip [context], -fast, and trailing -YYYYMMDD date. */
function baseModel(model) {
  return model
    .replace(/\[[^\]]*\]/g, '')
    .replace(/-fast$/, '')
    .replace(/-\d{8}$/, '')
    .trim();
}

const zero = () => ({ in: 0, out: 0, cacheRead: 0, cacheCreation: 0, usd: 0 });

/** Price one session's tokensByModel; accumulate unpriced models by name. Returns {usd, byModel, tokens}. */
function priceSession(session, prices, unpriced) {
  const byModel = {};
  let usd = 0;
  const buckets = session.tokensByModel || {};
  for (const [rawModel, t] of Object.entries(buckets)) {
    const key = baseModel(rawModel);
    const p = prices[key];
    if (!p) {
      const u = (unpriced[rawModel] ||= zero());
      u.in += t.in; u.out += t.out; u.cacheRead += t.cacheRead; u.cacheCreation += t.cacheCreation;
      continue;
    }
    const c = (t.in * p.in + t.out * p.out + t.cacheRead * p.cacheRead + t.cacheCreation * p.cacheCreation) / 1e6;
    byModel[key] = { in: t.in, out: t.out, cacheRead: t.cacheRead, cacheCreation: t.cacheCreation, usd: round(c) };
    usd += c;
  }
  return { usd: round(usd), byModel };
}

const round = (n) => Math.round(n * 1e6) / 1e6;

/** Merge session byModel maps into an accumulator keyed by base model. */
function addByModel(acc, byModel) {
  for (const [m, v] of Object.entries(byModel)) {
    const a = (acc[m] ||= zero());
    a.in += v.in; a.out += v.out; a.cacheRead += v.cacheRead; a.cacheCreation += v.cacheCreation;
    a.usd = round(a.usd + v.usd);
  }
}

function rollup(signals, prices) {
  const unpriced = {};
  const perSession = signals.sessions.map((s) => {
    const { usd, byModel } = priceSession(s, prices, unpriced);
    return { id: s.id, title: s.aiTitle || '', prs: s.prs || [], usd, byModel };
  });
  const byId = new Map(perSession.map((s) => [s.id, s]));

  const initiativeByModel = {};
  let total = 0;
  for (const s of perSession) { addByModel(initiativeByModel, s.byModel); total += s.usd; }

  const perPr = (signals.prs || []).map((pr) => {
    const byModel = {};
    let usd = 0;
    for (const sid of pr.sessions || []) {
      const s = byId.get(sid);
      if (!s) continue;
      addByModel(byModel, s.byModel);
      usd += s.usd;
    }
    return { number: pr.number, url: pr.url, merged: pr.merged, branch: pr.branch, sessions: (pr.sessions || []).length, usd: round(usd), byModel };
  });
  perPr.sort((a, b) => b.usd - a.usd);
  perSession.sort((a, b) => b.usd - a.usd);

  return {
    repo: signals.repo,
    pricingVersion: null,
    generatedFrom: signals.generatedFrom || null,
    initiative: { totalUsd: round(total), sessionCount: perSession.length, byModel: initiativeByModel },
    perPr,
    perSession,
    unpriced: Object.fromEntries(Object.entries(unpriced).map(([k, v]) => [k, v])),
  };
}

const usd = (n) => `$${n.toFixed(2)}`;

function printSummary(r) {
  const i = r.initiative;
  console.log(`cost rollup for ${r.repo} — pricing ${r.pricingVersion}`);
  console.log(`\ninitiative total: ${usd(i.totalUsd)} across ${i.sessionCount} sessions`);
  console.log('  by model:');
  for (const [m, v] of Object.entries(i.byModel).sort((a, b) => b[1].usd - a[1].usd))
    console.log(`    ${usd(v.usd).padStart(10)}  ${m}  (cacheCreation ${(v.cacheCreation / 1e6).toFixed(1)}M, out ${(v.out / 1e6).toFixed(1)}M)`);
  const priced = r.perPr.filter((p) => p.usd > 0);
  console.log(`\ntop PRs by cost (${priced.length} of ${r.perPr.length} with attributed spend):`);
  for (const p of priced.slice(0, 10))
    console.log(`  ${usd(p.usd).padStart(10)}  #${p.number}  ${p.sessions}s  ${p.merged ? 'merged' : 'open'}  ${p.branch || ''}`);
  const un = Object.entries(r.unpriced);
  if (un.length) {
    console.log(`\n⚠ unpriced models (add to pricing table): ${un.length}`);
    for (const [m, v] of un) console.log(`    ${m}  (in ${v.in}, out ${v.out}, cacheRead ${v.cacheRead}, cacheCreation ${v.cacheCreation})`);
  }
  const prSum = r.perPr.reduce((a, p) => a + p.usd, 0);
  console.log(`\nnote: Σ per-PR cost ${usd(prSum)} ≠ initiative total ${usd(i.totalUsd)} — sessions can touch 0 or several PRs; PR cost double-counts shared sessions and excludes PR-less sessions.`);
}

function toTsModule(r) {
  return (
    '// AUTO-GENERATED by tools/cost-rollup.mjs — token spend priced per model and\n' +
    '// rolled up to each session, PR, and the initiative. Re-run to refresh.\n' +
    `// pricing table version: ${r.pricingVersion}\n` +
    '/* eslint-disable */\n' +
    `export const costRollup = ${JSON.stringify(r, null, 2)} as const;\n` +
    'export type CostRollup = typeof costRollup;\n'
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.signals && !args.repo) {
    console.error('usage: cost-rollup.mjs --signals <file.ts|.json> | --repo <path> [--pricing f] [--out f] [--json]');
    process.exit(2);
  }
  const pricingDoc = JSON.parse(await fs.readFile(args.pricing, 'utf8'));
  const signals = args.repo ? await mineRepo(args.repo) : await loadSignals(args.signals);
  const report = rollup(signals, pricingDoc.models);
  report.pricingVersion = pricingDoc.version;

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const out = args.out || path.join(here, '..', 'data', 'cost-rollup.ts');
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, toTsModule(report), 'utf8');
  printSummary(report);
  console.log(`\nwrote ${out}`);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
