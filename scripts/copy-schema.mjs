#!/usr/bin/env node
/* eslint-disable no-undef -- Node ESM build script */
/**
 * Copy the session-index DDL into `dist/` after a tsup build.
 *
 * `src/miner/session-index/db.ts` reads `new URL('./schema.sql', import.meta.url)`
 * at runtime so the DDL stays a real, diffable `.sql` file. tsup bundles the
 * TypeScript but not the asset, and `package.json#files` ships only `dist/`, so
 * without this step a published install throws ENOENT the first time anything
 * opens the index. Written as a script rather than an inline `cp` in the tsup
 * config so it works identically on Windows.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src', 'miner', 'session-index', 'schema.sql');
const destination = path.join(root, 'dist', 'schema.sql');

if (!existsSync(source)) {
  console.error(`copy-schema: missing source ${source}`);
  process.exit(1);
}

mkdirSync(path.dirname(destination), { recursive: true });
copyFileSync(source, destination);

if (!existsSync(destination)) {
  console.error(`copy-schema: failed to write ${destination}`);
  process.exit(1);
}
