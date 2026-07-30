import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/aw.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  // `schema.sql` is read from disk at runtime; tsup bundles code, not assets.
  onSuccess: 'node scripts/copy-schema.mjs',
});
