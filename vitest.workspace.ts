import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['__tests__/**/*.test.ts'],
      exclude: ['__tests__/integration/**'],
      pool: 'threads',
      poolOptions: {
        threads: {
          maxThreads: 4,
        },
      },
    },
  },
  {
    test: {
      name: 'integration',
      include: ['__tests__/integration/**/*.test.ts'],
      pool: 'threads',
      poolOptions: {
        threads: {
          maxThreads: 1,
        },
      },
      testTimeout: 60_000,
      hookTimeout: 120_000,
    },
  },
]);
