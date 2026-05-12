/**
 * Dashboard static-asset handler.
 *
 * If `dist/dashboard/` exists (produced by a future `pnpm build:dashboard`),
 * we serve its contents under `/ui/*`. Otherwise we return a friendly
 * placeholder page so first-run users know what to do.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>active-work dashboard</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
      code { background: #f4f4f5; padding: 0.1rem 0.3rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>active-work</h1>
    <p>Dashboard not built yet — run <code>pnpm build:dashboard</code>.</p>
    <p>The daemon is running; use the CLI or MCP for now.</p>
  </body>
</html>`;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function contentTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Resolve the bundled dashboard directory. We look relative to the
 * compiled file (`dist/server/...`) for `dist/dashboard/`; in dev (tsx),
 * we look relative to `src/server/...` then up to `dist/dashboard/`.
 */
function dashboardDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/server -> dist/dashboard
  return path.resolve(here, '..', 'dashboard');
}

async function safeStat(p: string): Promise<{ exists: boolean; isFile: boolean }> {
  try {
    const stat = await fs.stat(p);
    return { exists: true, isFile: stat.isFile() };
  } catch {
    return { exists: false, isFile: false };
  }
}

export async function handleDashboard(c: Context): Promise<Response> {
  const root = dashboardDir();
  const rootStat = await safeStat(root);
  if (!rootStat.exists) {
    return c.html(PLACEHOLDER_HTML, 200);
  }

  // Strip the route prefix to get the asset-relative path.
  const url = new URL(c.req.url);
  const subpath = url.pathname.replace(/^\/ui\/?/, '');
  const relative = subpath === '' ? 'index.html' : subpath;

  // Guard against path traversal.
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep) && target !== root) {
    return c.text('forbidden', 403);
  }

  const stat = await safeStat(target);
  if (!stat.exists || !stat.isFile) {
    // Fall back to index.html for SPA routing.
    const indexPath = path.join(root, 'index.html');
    const indexStat = await safeStat(indexPath);
    if (!indexStat.exists) {
      return c.html(PLACEHOLDER_HTML, 200);
    }
    const body = await fs.readFile(indexPath);
    return c.body(new Uint8Array(body), 200, {
      'content-type': 'text/html; charset=utf-8',
    });
  }

  const body = await fs.readFile(target);
  return c.body(new Uint8Array(body), 200, {
    'content-type': contentTypeFor(target),
  });
}
