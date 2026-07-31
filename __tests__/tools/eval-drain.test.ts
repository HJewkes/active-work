// Unit tests for the pure helpers of tools/eval-drain.mjs. The full eval needs
// the operator's private ~/.claude corpus (not available in CI), but this is
// the math that decides whether a real coverage hole, a runaway template count
// or a false merge is reported or silently passed — so it is exercised here.
import { describe, it, expect } from 'vitest';
import {
  coverage,
  stabilityCurve,
  compareSets,
  clusterDiversity,
  supportDistribution,
  // @ts-expect-error — importing a plain .mjs (no type declarations) from a test.
} from '../../tools/eval-drain.mjs';

describe('coverage', () => {
  it('reports the blob and line funnels separately', () => {
    const result = coverage({ linesRead: 100, malformedLines: 5, blobs: 40, ingested: 38 });
    expect(result.lineParseRate).toBe(0.95);
    expect(result.blobCoverage).toBe(0.95);
    expect(result.skipped).toBe(2);
  });

  it('treats an empty pass as fully covered rather than dividing by zero', () => {
    const result = coverage({ linesRead: 0, malformedLines: 0, blobs: 0, ingested: 0 });
    expect(result.lineParseRate).toBe(1);
    expect(result.blobCoverage).toBe(1);
  });

  it('reports the eligibility screen separately from coverage', () => {
    // Coverage stays 100% — every eligible blob clustered — while the screen is
    // its own visible number, so narrowing cannot hide inside the gate.
    const result = coverage({
      linesRead: 100,
      malformedLines: 0,
      candidateBlobs: 1000,
      screened: 900,
      blobs: 100,
      ingested: 100,
    });
    expect(result.blobCoverage).toBe(1);
    expect(result.screened).toBe(900);
    expect(result.eligibilityRate).toBe(0.1);
  });
});

describe('supportDistribution', () => {
  it('splits clusters into singletons and recurring shapes', () => {
    const result = supportDistribution([
      { occurrenceCount: 1 },
      { occurrenceCount: 1 },
      { occurrenceCount: 7 },
      { occurrenceCount: 2 },
    ]);
    expect(result).toEqual({ templates: 4, singletons: 2, recurring: 2, singletonRate: 0.5 });
  });

  it('handles an empty store', () => {
    expect(supportDistribution([]).singletonRate).toBe(0);
  });
});

describe('stabilityCurve', () => {
  const sample = (blobs: number, templates: number, evicting = false) => ({
    blobs,
    templates,
    evicting,
  });

  it('reports a ratio well under 1 when the new-template rate decays', () => {
    const result = stabilityCurve([
      sample(100, 50),
      sample(200, 70),
      sample(300, 80),
      sample(400, 85),
    ]);
    // First half: 70/200 = 0.35. Second half: (85-70)/200 = 0.075.
    expect(result.splitAtBlobs).toBe(200);
    expect(result.firstRate).toBe(0.35);
    expect(result.lastRate).toBe(0.075);
    expect(result.ratio).toBeLessThan(0.5);
  });

  it('reports a ratio at ~1 when every blob still mints its own template', () => {
    const result = stabilityCurve([
      sample(100, 100),
      sample(200, 200),
      sample(300, 300),
      sample(400, 400),
    ]);
    expect(result.ratio).toBe(1);
  });

  it('gates only on pre-eviction samples and reports the tail separately', () => {
    const result = stabilityCurve([
      sample(100, 50),
      sample(200, 70),
      sample(300, 200, true),
      sample(400, 400, true),
    ]);
    expect(result.evictionAt).toBe(300);
    expect(result.gatedOn).toBe(200);
    expect(result.ratio).toBeLessThan(1);
    expect(result.postEviction).toEqual({ blobs: 200, newTemplates: 330, rate: 1.65 });
  });

  it('reports no post-eviction segment when the cap was never reached', () => {
    expect(stabilityCurve([sample(100, 50), sample(200, 70)]).postEviction).toBeNull();
  });

  it('degrades safely on too few usable samples', () => {
    expect(stabilityCurve([]).ratio).toBe(1);
    expect(stabilityCurve([sample(100, 50, true), sample(200, 90, true)]).ratio).toBe(1);
  });

  it('keeps every sample in the reported curve, evicting or not', () => {
    const result = stabilityCurve([sample(100, 50), sample(200, 70, true)]);
    expect(result.samples).toHaveLength(2);
    expect(result.samples[0].rate).toBe(0.5);
  });
});

describe('compareSets', () => {
  it('calls identical sets identical regardless of order', () => {
    const result = compareSets(['a', 'b'], ['b', 'a']);
    expect(result.identical).toBe(true);
    expect(result.divergence).toBe(0);
  });

  it('reports both sides of a symmetric difference', () => {
    const result = compareSets(['a', 'b', 'c'], ['b', 'c', 'd']);
    expect(result.identical).toBe(false);
    expect(result.onlyLeft).toEqual(['a']);
    expect(result.onlyRight).toEqual(['d']);
    expect(result.divergence).toBe(round2(2 / 6));
  });

  it('bounds the reported samples', () => {
    const left = Array.from({ length: 50 }, (_, i) => `l${i}`);
    expect(compareSets(left, [], 3).onlyLeft).toHaveLength(3);
  });

  it('does not divide by zero on two empty sets', () => {
    expect(compareSets([], []).divergence).toBe(0);
  });
});

describe('clusterDiversity', () => {
  it('accepts a cluster whose members share one error class', () => {
    const result = clusterDiversity([
      { errorClass: 'TypeError', maskedSignature: 'TypeError a <NUM>' },
      { errorClass: 'TypeError', maskedSignature: 'TypeError b <NUM>' },
    ]);
    expect(result.distinctErrorClasses).toBe(1);
    expect(result.distinctSignatures).toBe(2);
    expect(result.suspicious).toBe(false);
  });

  it('flags a cluster that merged distinct error classes', () => {
    const result = clusterDiversity([
      { errorClass: 'TypeError', maskedSignature: 'TypeError a' },
      { errorClass: 'ENOENT', maskedSignature: 'ENOENT b' },
    ]);
    expect(result.suspicious).toBe(true);
    expect(result.errorClasses).toEqual(['TypeError', 'ENOENT']);
  });

  it('reports zero signature diversity for an empty cluster', () => {
    expect(clusterDiversity([]).signatureDiversity).toBe(0);
  });
});

const round2 = (n: number) => Math.round(n * 1e4) / 1e4;
