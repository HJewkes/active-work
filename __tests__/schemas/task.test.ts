import { describe, expect, it } from 'vitest';

import { TaskSchema } from '../../src/schemas/task.js';

const validBase = {
  id: 'EC-1',
  title: 'Set up schemas',
  priority: 1,
  status: 'open' as const,
  created: '2026-05-12',
  updated: '2026-05-12',
  done_at: null,
};

describe('TaskSchema', () => {
  it('accepts a golden valid task', () => {
    const result = TaskSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it('accepts all optional fields populated', () => {
    const result = TaskSchema.safeParse({
      ...validBase,
      severity: 'high',
      estimate: 2.5,
      done_when: 'tests pass',
      tags: ['infra', 'wave1'],
      notes: 'remember to bump schema_version',
      done_at: '2026-05-13',
      status: 'done',
    });
    expect(result.success).toBe(true);
  });

  it.each(['id', 'title', 'priority', 'status', 'created', 'updated', 'done_at'])(
    'rejects when required field %s is missing',
    (field) => {
      const input: Record<string, unknown> = { ...validBase };
      delete input[field];
      const result = TaskSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === field)).toBe(true);
      }
    },
  );

  it.each(['ec-1', 'EC1', 'EC-', '1EC-1', 'EC-abc', 'eC-1'])('rejects invalid id %s', (id) => {
    const result = TaskSchema.safeParse({ ...validBase, id });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'id')).toBe(true);
    }
  });

  it('accepts uppercase prefix with digits', () => {
    expect(TaskSchema.safeParse({ ...validBase, id: 'A1B2-99' }).success).toBe(true);
  });

  it('leaves the status set to the category registry but rejects an empty status', () => {
    expect(TaskSchema.safeParse({ ...validBase, status: 'wont-do' }).success).toBe(true);
    expect(TaskSchema.safeParse({ ...validBase, status: '' }).success).toBe(false);
  });

  it('accepts parent and dep fields and rejects a repeated dep', () => {
    expect(TaskSchema.safeParse({ ...validBase, parent: 'EC-2', dep: ['EC-3'] }).success).toBe(
      true,
    );
    expect(TaskSchema.safeParse({ ...validBase, dep: ['EC-3', 'EC-3'] }).success).toBe(false);
  });

  it('rejects invalid severity enum', () => {
    const result = TaskSchema.safeParse({ ...validBase, severity: 'urgent' });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive priority', () => {
    expect(TaskSchema.safeParse({ ...validBase, priority: 0 }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...validBase, priority: -1 }).success).toBe(false);
  });

  it('rejects non-positive estimate', () => {
    expect(TaskSchema.safeParse({ ...validBase, estimate: 0 }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...validBase, estimate: -2 }).success).toBe(false);
  });

  it('rejects non-zero-padded date "2026-5-1"', () => {
    const result = TaskSchema.safeParse({ ...validBase, created: '2026-5-1' });
    expect(result.success).toBe(false);
  });

  it('rejects impossible date "2026-13-01"', () => {
    const result = TaskSchema.safeParse({ ...validBase, updated: '2026-13-01' });
    expect(result.success).toBe(false);
  });

  it('accepts done_at as null or as a valid date', () => {
    expect(TaskSchema.safeParse({ ...validBase, done_at: null }).success).toBe(true);
    expect(TaskSchema.safeParse({ ...validBase, done_at: '2026-05-13' }).success).toBe(true);
  });

  it('rejects done_at as an invalid date string', () => {
    const result = TaskSchema.safeParse({ ...validBase, done_at: '2026-13-01' });
    expect(result.success).toBe(false);
  });

  it('accepts created and done_at as a date-only value or a full timestamp, side by side', () => {
    const dateOnly = { ...validBase, status: 'done', created: '2026-05-12', done_at: '2026-05-13' };
    const timestamp = {
      ...validBase,
      status: 'done',
      created: '2026-05-12T08:15:00.000Z',
      done_at: '2026-05-13T17:30:45.123Z',
      started_at: '2026-05-12T09:00:00.000Z',
    };

    expect(TaskSchema.parse(dateOnly)).toMatchObject({ done_at: '2026-05-13' });
    expect(TaskSchema.parse(timestamp)).toMatchObject({
      created: '2026-05-12T08:15:00.000Z',
      done_at: '2026-05-13T17:30:45.123Z',
      started_at: '2026-05-12T09:00:00.000Z',
    });
  });

  it('rejects a malformed timestamp and a date-only started_at', () => {
    expect(TaskSchema.safeParse({ ...validBase, done_at: '2026-05-13T25:00:00Z' }).success).toBe(
      false,
    );
    expect(TaskSchema.safeParse({ ...validBase, started_at: '2026-05-13' }).success).toBe(false);
  });

  it('rejects empty title', () => {
    const result = TaskSchema.safeParse({ ...validBase, title: '' });
    expect(result.success).toBe(false);
  });
});
