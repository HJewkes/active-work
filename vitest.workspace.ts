import { defineWorkspace } from 'vitest/config';

// Files that stub HOME or os.homedir() in-process need real process isolation.
// One line per file saying why it cannot run on the threads pool.
const FORKS_FILES = [
  // assigns process.env.HOME and spawns the CLI against it
  '__tests__/integration/end-to-end.test.ts',
  // assigns process.env.HOME to probe the root-shape guard
  '__tests__/setup/test-helpers-guard.test.ts',
  // assigns process.env.HOME before building the watcher
  '__tests__/server/session-index-watch.test.ts',
  // spies on os.homedir() with a fake home
  '__tests__/commands/setup.test.ts',
];

// Phases run one after another (groupOrder) so the 4-thread and 2-fork caps never stack.
export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['__tests__/**/*.test.ts'],
      exclude: ['__tests__/integration/**', ...FORKS_FILES],
      globalSetup: ['./__tests__/setup/global-setup.ts'],
      setupFiles: ['./__tests__/setup/sandbox-home.ts'],
      pool: 'threads',
      sequence: { groupOrder: 1 },
    },
  },
  {
    test: {
      name: 'integration',
      include: ['__tests__/integration/**/*.test.ts'],
      exclude: FORKS_FILES,
      setupFiles: ['./__tests__/setup/sandbox-home.ts'],
      pool: 'threads',
      testTimeout: 60_000,
      hookTimeout: 120_000,
      sequence: { groupOrder: 2 },
    },
  },
  {
    test: {
      name: 'forks',
      include: FORKS_FILES,
      globalSetup: ['./__tests__/setup/global-setup.ts'],
      setupFiles: ['./__tests__/setup/sandbox-home.ts'],
      pool: 'forks',
      testTimeout: 60_000,
      hookTimeout: 120_000,
      sequence: { groupOrder: 3 },
    },
  },
]);
