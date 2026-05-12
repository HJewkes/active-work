import { describe, expect, it } from 'vitest';

import { SessionFrontmatterSchema } from '../../src/schemas/session.js';

const validBase = {
  session_id: '01HXYZ',
  started: '2026-05-12T10:00:00Z',
  ended: '2026-05-12T11:30:00Z',
  track: 'canonical' as const,
};

describe('SessionFrontmatterSchema', () => {
  it('accepts a golden valid session', () => {
    const result = SessionFrontmatterSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it('accepts ISO 8601 with offset and fractional seconds', () => {
    expect(
      SessionFrontmatterSchema.safeParse({
        ...validBase,
        started: '2026-05-12T10:00:00.123+02:00',
        ended: '2026-05-12T11:30:00.456+02:00',
      }).success,
    ).toBe(true);
  });

  it('accepts ended equal to started', () => {
    expect(
      SessionFrontmatterSchema.safeParse({
        ...validBase,
        ended: validBase.started,
      }).success,
    ).toBe(true);
  });

  it.each(['session_id', 'started', 'ended', 'track'])(
    'rejects when required field %s is missing',
    (field) => {
      const input: Record<string, unknown> = { ...validBase };
      delete input[field];
      const result = SessionFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === field)).toBe(true);
      }
    },
  );

  it('rejects empty session_id', () => {
    const result = SessionFrontmatterSchema.safeParse({ ...validBase, session_id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid track enum', () => {
    const result = SessionFrontmatterSchema.safeParse({ ...validBase, track: 'main' });
    expect(result.success).toBe(false);
  });

  it('rejects ISO 8601 strings without timezone', () => {
    const result = SessionFrontmatterSchema.safeParse({
      ...validBase,
      started: '2026-05-12T10:00:00',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed datetime strings', () => {
    const result = SessionFrontmatterSchema.safeParse({
      ...validBase,
      started: '2026-05-12 10:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects ended < started', () => {
    const result = SessionFrontmatterSchema.safeParse({
      ...validBase,
      started: '2026-05-12T11:00:00Z',
      ended: '2026-05-12T10:00:00Z',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === 'ended')).toBe(true);
    }
  });
});
