import { defineConfig } from 'vitest/config';

// A change to any of these selects every test under --changed. Vitest matches the
// globs against absolute paths with picomatch, whose `**` skips dot-directories, so
// each name also gets a dot-directory-tolerant form (worktrees live under `.worktrees`).
const FORCE_RERUN_TRIGGERS = [
  'pnpm-lock.yaml',
  'vitest.config.ts',
  'vitest.workspace.ts',
  'tsconfig*.json',
  'package.json',
].map((name) => `{**/,**/.*/**/}${name}`);

export default defineConfig({
  test: {
    globals: true,
    passWithNoTests: true,
    forceRerunTriggers: FORCE_RERUN_TRIGGERS,
    teardownTimeout: 30_000,
    hookTimeout: 30_000,
    // vitest 3.x reads poolOptions only from the root, so the caps live here
    poolOptions: {
      threads: { maxThreads: 4, minThreads: 1 },
      forks: { maxForks: 2, minForks: 1 },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/dashboard/**', 'src/**/*.test.ts'],
    },
  },
});
