import { describe, expect, it } from 'vitest';

import { SessionFrontmatterSchema } from '../../src/schemas/session.js';

const validBase = {
  session_id: '8f2c1a44',
  started: '2026-05-12T10:00:00Z',
  ended: '2026-05-12T11:30:00Z',
  track: 'canonical' as const,
};

describe('SessionFrontmatterSchema open-loop fields', () => {
  it('defaults next_steps and resolves to empty arrays', () => {
    const result = SessionFrontmatterSchema.parse(validBase);
    expect(result.next_steps).toEqual([]);
    expect(result.resolves).toEqual([]);
  });

  it('accepts a full ledger', () => {
    const result = SessionFrontmatterSchema.safeParse({
      ...validBase,
      next_steps: [
        { id: 'n1', text: 'Wire cost rollup into the daemon', kind: 'prose' },
        { id: 'n2', text: 'Land the index', kind: 'task', ref: 'AW-24' },
      ],
      resolves: [{ ref: '8f2c1a44#n3', outcome: 'done' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate next_step ids within a session', () => {
    const result = SessionFrontmatterSchema.safeParse({
      ...validBase,
      next_steps: [
        { id: 'n1', text: 'first', kind: 'prose' },
        { id: 'n1', text: 'second', kind: 'prose' },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'next_steps.1.id')).toBe(true);
    }
  });

  it('rejects an unknown next_step kind', () => {
    const result = SessionFrontmatterSchema.safeParse({
      ...validBase,
      next_steps: [{ id: 'n1', text: 'x', kind: 'epic' }],
    });
    expect(result.success).toBe(false);
  });

  it('requires a note when a resolve outcome is abandoned', () => {
    const result = SessionFrontmatterSchema.safeParse({
      ...validBase,
      resolves: [{ ref: 'a91b#n1', outcome: 'abandoned' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'resolves.0.note')).toBe(true);
    }
  });

  it('accepts an abandoned resolve carrying a note', () => {
    expect(
      SessionFrontmatterSchema.safeParse({
        ...validBase,
        resolves: [
          { ref: 'a91b#n1', outcome: 'abandoned', note: 'superseded by the SQLite index' },
        ],
      }).success,
    ).toBe(true);
  });

  it('does not require a note when the outcome is done', () => {
    expect(
      SessionFrontmatterSchema.safeParse({
        ...validBase,
        resolves: [{ ref: 'a91b#n1', outcome: 'done' }],
      }).success,
    ).toBe(true);
  });

  it('rejects a resolve ref that is not <session_id>#<id>', () => {
    const result = SessionFrontmatterSchema.safeParse({
      ...validBase,
      resolves: [{ ref: 'a91b-n1', outcome: 'done' }],
    });
    expect(result.success).toBe(false);
  });
});
