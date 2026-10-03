import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseMachinePressure,
  readMachinePressure,
  shouldHold,
} from '../../src/utils/machine-pressure.js';
import type { RunCommand } from '../../src/discover/run-command.js';

// Captured shape of `sysctl -n vm.swapusage kern.memorystatus_vm_pressure_level`, synthetic numbers.
const sample = (used: string, level: number): string =>
  `total = 2048.00M  used = ${used}M  free = 100.00M  (encrypted)\n${level}\n`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseMachinePressure', () => {
  it('reads swap used as a percentage of total and the pressure level', () => {
    expect(parseMachinePressure(sample('1024.00', 2))).toEqual({
      swapUsedPct: 50,
      pressureLevel: 2,
    });
  });

  it('reports zero swap use when the machine has no swap file', () => {
    const out = 'total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\n1\n';

    expect(parseMachinePressure(out)).toEqual({ swapUsedPct: 0, pressureLevel: 1 });
  });

  it('returns null for output it does not recognise', () => {
    expect(parseMachinePressure('sysctl: unknown oid\n')).toBeNull();
  });
});

describe('readMachinePressure', () => {
  it('asks sysctl once for both values through the injected runner', async () => {
    const run = vi.fn<RunCommand>(async () => ({
      code: 0,
      stdout: sample('512.00', 1),
      stderr: '',
    }));

    const pressure = await readMachinePressure(run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('sysctl', [
      '-n',
      'vm.swapusage',
      'kern.memorystatus_vm_pressure_level',
    ]);
    expect(pressure).toEqual({ swapUsedPct: 25, pressureLevel: 1 });
  });

  it('returns null when sysctl fails, so a missing probe never holds the index', async () => {
    const run: RunCommand = async () => ({ code: 1, stdout: '', stderr: 'denied' });

    expect(await readMachinePressure(run)).toBeNull();
  });

  it('returns null when the runner throws', async () => {
    const run: RunCommand = async () => {
      throw new Error('spawn sysctl ENOENT');
    };

    expect(await readMachinePressure(run)).toBeNull();
  });
});

describe('shouldHold', () => {
  const at = (swapUsedPct: number, pressureLevel = 1) => ({ swapUsedPct, pressureLevel });

  it('holds above 60% swap and not at 59%', () => {
    expect(shouldHold(at(61))).toMatchObject({ hold: true });
    expect(shouldHold(at(59))).toEqual({ hold: false });
  });

  it('holds at pressure level 2 and above', () => {
    expect(shouldHold(at(0, 2))).toMatchObject({ hold: true });
    expect(shouldHold(at(0, 4))).toMatchObject({ hold: true });
  });

  it('names the cause so the pause log line says why', () => {
    expect(shouldHold(at(75)).reason).toContain('swap 75%');
    expect(shouldHold(at(0, 2)).reason).toContain('pressure level 2');
  });

  it('honours AW_INDEX_HOLD_SWAP_PCT', () => {
    vi.stubEnv('AW_INDEX_HOLD_SWAP_PCT', '90');

    expect(shouldHold(at(80))).toEqual({ hold: false });
    expect(shouldHold(at(91))).toMatchObject({ hold: true });
  });

  it('does not hold when the probe could not read the machine', () => {
    expect(shouldHold(null)).toEqual({ hold: false });
  });
});
