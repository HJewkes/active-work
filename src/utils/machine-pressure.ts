import { runCommand, type RunCommand } from '../discover/run-command.js';

export interface MachinePressure {
  swapUsedPct: number;
  /** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
  pressureLevel: number;
}

export interface HoldDecision {
  hold: boolean;
  reason?: string;
}

const DEFAULT_HOLD_SWAP_PCT = 60;
const HOLD_PRESSURE_LEVEL = 2;
const SWAP_LINE = /total = ([\d.]+)M\s+used = ([\d.]+)M/;

/** Pure: turns the output of `sysctl -n vm.swapusage kern.memorystatus_vm_pressure_level` into numbers. */
export function parseMachinePressure(stdout: string): MachinePressure | null {
  const [swapLine = '', levelLine = ''] = stdout.trim().split('\n');
  const swap = SWAP_LINE.exec(swapLine);
  const pressureLevel = Number(levelLine.trim());
  if (!swap || levelLine.trim() === '' || !Number.isFinite(pressureLevel)) return null;
  const total = Number(swap[1]);
  const used = Number(swap[2]);
  return { swapUsedPct: total > 0 ? (used / total) * 100 : 0, pressureLevel };
}

/** Null when the probe fails: an unreadable machine must never stall the index. */
export async function readMachinePressure(
  run: RunCommand = runCommand,
): Promise<MachinePressure | null> {
  try {
    const result = await run('sysctl', [
      '-n',
      'vm.swapusage',
      'kern.memorystatus_vm_pressure_level',
    ]);
    return result.code === 0 ? parseMachinePressure(result.stdout) : null;
  } catch {
    return null;
  }
}

function holdSwapPct(): number {
  const value = Number(process.env.AW_INDEX_HOLD_SWAP_PCT);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_HOLD_SWAP_PCT;
}

export function shouldHold(pressure: MachinePressure | null): HoldDecision {
  if (!pressure) return { hold: false };
  const limit = holdSwapPct();
  if (pressure.swapUsedPct > limit) {
    return {
      hold: true,
      reason: `swap ${Math.round(pressure.swapUsedPct)}% used (limit ${limit}%)`,
    };
  }
  if (pressure.pressureLevel >= HOLD_PRESSURE_LEVEL) {
    return { hold: true, reason: `memory pressure level ${pressure.pressureLevel}` };
  }
  return { hold: false };
}
