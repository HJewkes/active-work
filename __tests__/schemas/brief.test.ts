import { describe, expect, it } from 'vitest';

import { BriefFrontmatterSchema } from '../../src/schemas/brief.js';

const validBase = {
  schema_version: 1,
  title: 'Active Work v2',
  updated: '2026-05-12',
  state: 'focused' as const,
  rank: 1,
  task_prefix: 'EC',
};

describe('BriefFrontmatterSchema', () => {
  it('accepts a golden valid focused brief', () => {
    const result = BriefFrontmatterSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it('accepts a paused brief with required fields', () => {
    const result = BriefFrontmatterSchema.safeParse({
      schema_version: 1,
      title: 'Paused initiative',
      updated: '2026-05-12',
      state: 'paused',
      paused_since: '2026-05-01',
      restart_trigger: 'API stabilizes',
      task_prefix: 'PI',
    });
    expect(result.success).toBe(true);
  });

  it('accepts optional worktrees record', () => {
    const result = BriefFrontmatterSchema.safeParse({
      ...validBase,
      worktrees: {
        main: { path: '/repo/main', default: true },
        feature: { path: '/repo/feature' },
      },
    });
    expect(result.success).toBe(true);
  });

  it.each([
    'schema_version',
    'title',
    'updated',
    'state',
    'task_prefix',
  ])('rejects when required field %s is missing', (field) => {
    const input: Record<string, unknown> = { ...validBase };
    delete input[field];
    const result = BriefFrontmatterSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === field)).toBe(true);
    }
  });

  it('fails when state is "focused" but rank is missing', () => {
    const { rank: _rank, ...withoutRank } = validBase;
    const result = BriefFrontmatterSchema.safeParse(withoutRank);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'rank')).toBe(true);
    }
  });

  it('fails when state is "paused" but paused_since is missing', () => {
    const result = BriefFrontmatterSchema.safeParse({
      schema_version: 1,
      title: 'Paused',
      updated: '2026-05-12',
      state: 'paused',
      restart_trigger: 'something',
      task_prefix: 'PA',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'paused_since')).toBe(true);
    }
  });

  it('fails when state is "paused" but restart_trigger is missing', () => {
    const result = BriefFrontmatterSchema.safeParse({
      schema_version: 1,
      title: 'Paused',
      updated: '2026-05-12',
      state: 'paused',
      paused_since: '2026-05-01',
      task_prefix: 'PA',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'restart_trigger')).toBe(true);
    }
  });

  it('rejects invalid state enum values', () => {
    const result = BriefFrontmatterSchema.safeParse({ ...validBase, state: 'archived' });
    expect(result.success).toBe(false);
  });

  it('rejects non-zero-padded date "2026-5-1"', () => {
    const result = BriefFrontmatterSchema.safeParse({ ...validBase, updated: '2026-5-1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'updated')).toBe(true);
    }
  });

  it('rejects impossible date "2026-13-01"', () => {
    const result = BriefFrontmatterSchema.safeParse({ ...validBase, updated: '2026-13-01' });
    expect(result.success).toBe(false);
  });

  it('rejects impossible day-of-month "2026-02-30"', () => {
    const result = BriefFrontmatterSchema.safeParse({ ...validBase, updated: '2026-02-30' });
    expect(result.success).toBe(false);
  });

  it('rejects schema_version of 0 or negative', () => {
    expect(BriefFrontmatterSchema.safeParse({ ...validBase, schema_version: 0 }).success).toBe(
      false,
    );
    expect(BriefFrontmatterSchema.safeParse({ ...validBase, schema_version: -1 }).success).toBe(
      false,
    );
  });

  it('rejects task_prefix that does not match uppercase pattern', () => {
    expect(BriefFrontmatterSchema.safeParse({ ...validBase, task_prefix: 'ec' }).success).toBe(
      false,
    );
    expect(BriefFrontmatterSchema.safeParse({ ...validBase, task_prefix: '1AB' }).success).toBe(
      false,
    );
    expect(BriefFrontmatterSchema.safeParse({ ...validBase, task_prefix: '' }).success).toBe(
      false,
    );
  });

  it('rejects empty title', () => {
    const result = BriefFrontmatterSchema.safeParse({ ...validBase, title: '' });
    expect(result.success).toBe(false);
  });
});
