import { describe, it, expect } from 'vitest';
import {
  EXIT,
  ActiveWorkError,
  ValidationError,
  NotFoundError,
  UsageError,
  DaemonError,
  ConfigError,
  SoftwareError,
  formatError,
  isActiveWorkError,
} from '../src/errors.js';

describe('EXIT constants', () => {
  it('uses BSD sysexits values', () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.GENERIC).toBe(1);
    expect(EXIT.USAGE).toBe(64);
    expect(EXIT.DATAERR).toBe(65);
    expect(EXIT.NOINPUT).toBe(66);
    expect(EXIT.UNAVAILABLE).toBe(69);
    expect(EXIT.SOFTWARE).toBe(70);
    expect(EXIT.CONFIG).toBe(78);
  });
});

describe('ActiveWorkError', () => {
  it('defaults to EXIT.GENERIC and has correct name', () => {
    const err = new ActiveWorkError('boom');
    expect(err.code).toBe(EXIT.GENERIC);
    expect(err.name).toBe('ActiveWorkError');
    expect(err.message).toBe('boom');
    expect(err).toBeInstanceOf(Error);
  });

  it('propagates cause via options', () => {
    const root = new Error('root');
    const err = new ActiveWorkError('wrapper', { cause: root });
    expect(err.cause).toBe(root);
  });
});

describe('error subclasses', () => {
  const cases = [
    { Cls: ValidationError, code: EXIT.DATAERR, name: 'ValidationError' },
    { Cls: NotFoundError, code: EXIT.NOINPUT, name: 'NotFoundError' },
    { Cls: UsageError, code: EXIT.USAGE, name: 'UsageError' },
    { Cls: DaemonError, code: EXIT.UNAVAILABLE, name: 'DaemonError' },
    { Cls: ConfigError, code: EXIT.CONFIG, name: 'ConfigError' },
    { Cls: SoftwareError, code: EXIT.SOFTWARE, name: 'SoftwareError' },
  ] as const;

  for (const { Cls, code, name } of cases) {
    it(`${name} has code ${code} and proper instanceof chain`, () => {
      const err = new Cls('msg');
      expect(err.code).toBe(code);
      expect(err.name).toBe(name);
      expect(err.message).toBe('msg');
      expect(err).toBeInstanceOf(Cls);
      expect(err).toBeInstanceOf(ActiveWorkError);
      expect(err).toBeInstanceOf(Error);
    });

    it(`${name} propagates cause`, () => {
      const root = new Error('root');
      const err = new Cls('msg', { cause: root });
      expect(err.cause).toBe(root);
    });
  }
});

describe('formatError', () => {
  it('maps ActiveWorkError subclasses to their code', () => {
    expect(formatError(new ValidationError('v'))).toEqual({
      message: 'v',
      code: EXIT.DATAERR,
    });
    expect(formatError(new NotFoundError('n'))).toEqual({
      message: 'n',
      code: EXIT.NOINPUT,
    });
    expect(formatError(new UsageError('u'))).toEqual({
      message: 'u',
      code: EXIT.USAGE,
    });
    expect(formatError(new DaemonError('d'))).toEqual({
      message: 'd',
      code: EXIT.UNAVAILABLE,
    });
    expect(formatError(new ConfigError('c'))).toEqual({
      message: 'c',
      code: EXIT.CONFIG,
    });
    expect(formatError(new SoftwareError('s'))).toEqual({
      message: 's',
      code: EXIT.SOFTWARE,
    });
    expect(formatError(new ActiveWorkError('a'))).toEqual({
      message: 'a',
      code: EXIT.GENERIC,
    });
  });

  it('maps generic Error to EXIT.GENERIC', () => {
    expect(formatError(new Error('oops'))).toEqual({
      message: 'oops',
      code: EXIT.GENERIC,
    });
  });

  it('maps primitives via String() with EXIT.GENERIC', () => {
    expect(formatError('plain string')).toEqual({
      message: 'plain string',
      code: EXIT.GENERIC,
    });
    expect(formatError(42)).toEqual({ message: '42', code: EXIT.GENERIC });
    expect(formatError(null)).toEqual({ message: 'null', code: EXIT.GENERIC });
    expect(formatError(undefined)).toEqual({
      message: 'undefined',
      code: EXIT.GENERIC,
    });
  });
});

describe('isActiveWorkError', () => {
  it('narrows to ActiveWorkError for the hierarchy', () => {
    const err: unknown = new ValidationError('bad');
    expect(isActiveWorkError(err)).toBe(true);
    if (isActiveWorkError(err)) {
      // type narrowed — should access .code without `any`
      expect(err.code).toBe(EXIT.DATAERR);
    }
  });

  it('returns false for generic Error', () => {
    expect(isActiveWorkError(new Error('x'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isActiveWorkError('string')).toBe(false);
    expect(isActiveWorkError(undefined)).toBe(false);
    expect(isActiveWorkError(null)).toBe(false);
    expect(isActiveWorkError({ code: 1, message: 'fake' })).toBe(false);
  });
});
