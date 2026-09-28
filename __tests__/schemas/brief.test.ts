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
  it('accepts an optional profile naming a Claude account directory', () => {
    const result = BriefFrontmatterSchema.safeParse({ ...validBase, profile: 'agents' });
    expect(result.success).toBe(true);
  });

  it('omits profile without complaint', () => {
    const result = BriefFrontmatterSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it.each(['../other', 'a/b', '/abs', '.', '..', ''])(
    'rejects profile %j so it cannot escape the profile root',
    (profile) => {
      const result = BriefFrontmatterSchema.safeParse({ ...validBase, profile });
      expect(result.success).toBe(false);
    },
  );

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

  it.each(['schema_version', 'title', 'updated', 'state', 'task_prefix'])(
    'rejects when required field %s is missing',
    (field) => {
      const input: Record<string, unknown> = { ...validBase };
      delete input[field];
      const result = BriefFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === field)).toBe(true);
      }
    },
  );

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
    expect(BriefFrontmatterSchema.safeParse({ ...validBase, task_prefix: '' }).success).toBe(false);
  });

  it('rejects empty title', () => {
    const result = BriefFrontmatterSchema.safeParse({ ...validBase, title: '' });
    expect(result.success).toBe(false);
  });
});

describe('BriefFrontmatterSchema autonomy block', () => {
  const autonomy = {
    mode: 'burndown',
    lanes: 2,
    accounts: ['agents'],
    grants: ['merge-on-green-approve', 'task-close-on-merged-pr'],
    repo: '~/projects/agent-chat',
  };

  it('keeps every field the burndown tick reads', () => {
    const result = BriefFrontmatterSchema.parse({ ...validBase, autonomy });
    expect(result.autonomy).toEqual(autonomy);
  });

  it('accepts a bare opt-in without adding defaults', () => {
    const result = BriefFrontmatterSchema.parse({ ...validBase, autonomy: { mode: 'burndown' } });
    expect(result.autonomy).toEqual({ mode: 'burndown' });
  });

  it('rejects an unknown key inside autonomy instead of stripping it', () => {
    const result = BriefFrontmatterSchema.safeParse({
      ...validBase,
      autonomy: { ...autonomy, grant: ['merge-on-green-approve'] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['grant'] });
  });

  it('rejects a grant the unlock table does not define, naming the valid ones', () => {
    const result = BriefFrontmatterSchema.safeParse({
      ...validBase,
      autonomy: { mode: 'burndown', grants: ['merge-anything'] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('merge-on-green-approve');
  });

  it('rejects any mode but burndown and says how to opt out', () => {
    const result = BriefFrontmatterSchema.safeParse({ ...validBase, autonomy: { mode: 'manual' } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('remove the autonomy block');
  });

  it.each([0, -1, 1.5])('rejects lanes %j', (lanes) => {
    const result = BriefFrontmatterSchema.safeParse({
      ...validBase,
      autonomy: { mode: 'burndown', lanes },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an account that could escape the profile root', () => {
    const result = BriefFrontmatterSchema.safeParse({
      ...validBase,
      autonomy: { mode: 'burndown', accounts: ['../personal'] },
    });
    expect(result.success).toBe(false);
  });
});
