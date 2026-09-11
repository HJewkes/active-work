import { defineConfig } from 'tsup';
import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('./package.json') as { version: string };

export default defineConfig({
  entry: ['src/cli.ts', 'src/aw.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  // So `--version` and `/health` report the build that is running rather than a
  // constant somebody has to remember to bump. Substituted textually, so it
  // needs no TS global and falls back to '0.0.0-dev' under vitest and tsx.
  define: { 'process.env.AW_VERSION': JSON.stringify(version) },
});
