// Placeholder vite config — Wave 5.1 replaces this with the real config.
// Kept here so `pnpm build:dashboard` doesn't fail before Wave 5.1 lands.
import { defineConfig } from 'vite';
export default defineConfig({
  root: __dirname,
  build: {
    outDir: '../../dist/dashboard',
    emptyOutDir: true,
    target: 'es2020',
  },
});
