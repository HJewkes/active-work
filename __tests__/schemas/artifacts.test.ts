import { describe, expect, it } from 'vitest';

import {
  ArtifactsSchema,
  BranchEntrySchema,
  PrEntrySchema,
  StashEntrySchema,
} from '../../src/schemas/artifacts.js';

const validPr = {
  number: 42,
  repo: 'HJewkes/active-work',
  title: 'feat: schemas',
  status: 'open' as const,
  last_checked: '2026-05-12T10:00:00Z',
};

const validBranch = {
  repo: 'HJewkes/active-work',
  name: 'wave1/schemas',
  last_commit: '2026-05-12',
};

const validStash = {
  repo: 'HJewkes/active-work',
  message: 'WIP zod schemas',
  created: '2026-05-12',
};

describe('PrEntrySchema', () => {
  it('accepts a golden valid PR entry', () => {
    expect(PrEntrySchema.safeParse(validPr).success).toBe(true);
  });

  it.each(['number', 'repo', 'title', 'status', 'last_checked'])(
    'rejects when required field %s is missing',
    (field) => {
      const input: Record<string, unknown> = { ...validPr };
      delete input[field];
      const result = PrEntrySchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === field)).toBe(true);
      }
    },
  );

  it('rejects non-positive number', () => {
    expect(PrEntrySchema.safeParse({ ...validPr, number: 0 }).success).toBe(false);
    expect(PrEntrySchema.safeParse({ ...validPr, number: -1 }).success).toBe(false);
  });

  it('rejects invalid status enum', () => {
    expect(PrEntrySchema.safeParse({ ...validPr, status: 'draft' }).success).toBe(false);
  });

  it('rejects malformed last_checked', () => {
    expect(PrEntrySchema.safeParse({ ...validPr, last_checked: '2026-05-12' }).success).toBe(
      false,
    );
  });

  it('rejects empty repo', () => {
    expect(PrEntrySchema.safeParse({ ...validPr, repo: '' }).success).toBe(false);
  });
});

describe('BranchEntrySchema', () => {
  it('accepts a golden valid branch entry', () => {
    expect(BranchEntrySchema.safeParse(validBranch).success).toBe(true);
  });

  it.each(['repo', 'name', 'last_commit'])(
    'rejects when required field %s is missing',
    (field) => {
      const input: Record<string, unknown> = { ...validBranch };
      delete input[field];
      const result = BranchEntrySchema.safeParse(input);
      expect(result.success).toBe(false);
    },
  );

  it('rejects non-zero-padded last_commit "2026-5-1"', () => {
    expect(
      BranchEntrySchema.safeParse({ ...validBranch, last_commit: '2026-5-1' }).success,
    ).toBe(false);
  });

  it('rejects impossible last_commit "2026-13-01"', () => {
    expect(
      BranchEntrySchema.safeParse({ ...validBranch, last_commit: '2026-13-01' }).success,
    ).toBe(false);
  });

  it('rejects empty name', () => {
    expect(BranchEntrySchema.safeParse({ ...validBranch, name: '' }).success).toBe(false);
  });
});

describe('StashEntrySchema', () => {
  it('accepts a golden valid stash entry', () => {
    expect(StashEntrySchema.safeParse(validStash).success).toBe(true);
  });

  it.each(['repo', 'message', 'created'])(
    'rejects when required field %s is missing',
    (field) => {
      const input: Record<string, unknown> = { ...validStash };
      delete input[field];
      expect(StashEntrySchema.safeParse(input).success).toBe(false);
    },
  );

  it('rejects malformed created date', () => {
    expect(StashEntrySchema.safeParse({ ...validStash, created: '2026-5-1' }).success).toBe(
      false,
    );
  });
});

describe('ArtifactsSchema', () => {
  it('accepts a fully-populated artifacts document', () => {
    const result = ArtifactsSchema.safeParse({
      prs: [validPr],
      branches: [validBranch],
      stashes: [validStash],
    });
    expect(result.success).toBe(true);
  });

  it('defaults missing arrays to empty arrays', () => {
    const result = ArtifactsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prs).toEqual([]);
      expect(result.data.branches).toEqual([]);
      expect(result.data.stashes).toEqual([]);
    }
  });

  it('rejects an entry with an invalid PR inside the array', () => {
    const result = ArtifactsSchema.safeParse({
      prs: [{ ...validPr, number: 0 }],
    });
    expect(result.success).toBe(false);
  });
});
