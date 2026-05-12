import { describe, it, expect } from 'vitest';
import {
  successEnvelope,
  errorEnvelope,
} from '../../src/registry/json-envelope.js';

describe('successEnvelope', () => {
  it('returns ok: true with data and no warnings key when warnings omitted', () => {
    const env = successEnvelope({ id: 1 });
    expect(env).toEqual({ ok: true, data: { id: 1 } });
    expect('warnings' in env).toBe(false);
  });

  it('includes warnings when provided non-empty', () => {
    const env = successEnvelope({ id: 1 }, ['something happened']);
    expect(env).toEqual({
      ok: true,
      data: { id: 1 },
      warnings: ['something happened'],
    });
  });

  it('omits warnings key when array is empty', () => {
    const env = successEnvelope({ id: 1 }, []);
    expect(env).toEqual({ ok: true, data: { id: 1 } });
    expect('warnings' in env).toBe(false);
  });
});

describe('errorEnvelope', () => {
  it('returns ok: false with error and code', () => {
    const env = errorEnvelope('bad input', 65);
    expect(env).toEqual({ ok: false, error: 'bad input', code: 65 });
  });
});
