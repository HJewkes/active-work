import { describe, expect, it } from 'vitest';

import {
  ArtifactsSchema,
  BranchEntrySchema,
  StashEntrySchema,
} from '../../src/schemas/artifacts.js';

const validBranch = {
  repo: 'HJewkes/active-work',
  name: 'wave1/schemas',
};

const validBranchWithNote = {
  repo: 'HJewkes/active-work',
  name: 'wave1/schemas',
  note: 'scaffolding for wave 1',
};

const validStash = {
  repo: 'HJewkes/active-work',
  label: 'WIP zod schemas',
};

const validStashWithSha = {
  repo: 'HJewkes/active-work',
  label: 'WIP zod schemas',
  sha: 'deadbeefcafe1234',
};

describe('BranchEntrySchema', () => {
  it('accepts a golden valid branch entry without note', () => {
    expect(BranchEntrySchema.safeParse(validBranch).success).toBe(true);
  });

  it('accepts a branch entry with note', () => {
    expect(BranchEntrySchema.safeParse(validBranchWithNote).success).toBe(true);
  });

  it.each(['repo', 'name'])(
    'rejects when required field %s is missing',
    (field) => {
      const input: Record<string, unknown> = { ...validBranch };
      delete input[field];
      const result = BranchEntrySchema.safeParse(input);
      expect(result.success).toBe(false);
    },
  );

  it('rejects empty name', () => {
    expect(BranchEntrySchema.safeParse({ ...validBranch, name: '' }).success).toBe(false);
  });

  it('rejects empty repo', () => {
    expect(BranchEntrySchema.safeParse({ ...validBranch, repo: '' }).success).toBe(false);
  });

  it('does not reject extra unknown fields by default but ignores them', () => {
    const result = BranchEntrySchema.safeParse({
      ...validBranch,
      last_commit: '2026-05-12',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).last_commit).toBeUndefined();
    }
  });
});

describe('StashEntrySchema', () => {
  it('accepts a golden valid stash entry', () => {
    expect(StashEntrySchema.safeParse(validStash).success).toBe(true);
  });

  it('accepts a stash entry with sha', () => {
    expect(StashEntrySchema.safeParse(validStashWithSha).success).toBe(true);
  });

  it.each(['repo', 'label'])(
    'rejects when required field %s is missing',
    (field) => {
      const input: Record<string, unknown> = { ...validStash };
      delete input[field];
      expect(StashEntrySchema.safeParse(input).success).toBe(false);
    },
  );

  it('rejects empty label', () => {
    expect(StashEntrySchema.safeParse({ ...validStash, label: '' }).success).toBe(false);
  });
});

describe('ArtifactsSchema', () => {
  it('accepts a fully-populated artifacts document', () => {
    const result = ArtifactsSchema.safeParse({
      branches: [validBranchWithNote],
      stashes: [validStashWithSha],
    });
    expect(result.success).toBe(true);
  });

  it('defaults missing arrays to empty arrays', () => {
    const result = ArtifactsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.branches).toEqual([]);
      expect(result.data.stashes).toEqual([]);
    }
  });

  it('does not carry a prs field', () => {
    const result = ArtifactsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).prs).toBeUndefined();
    }
  });

  it('rejects an entry with an invalid branch inside the array', () => {
    const result = ArtifactsSchema.safeParse({
      branches: [{ repo: '', name: 'feat/foo' }],
    });
    expect(result.success).toBe(false);
  });
});
