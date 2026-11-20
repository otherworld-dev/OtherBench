import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Hono } from 'hono';
import { containPath } from '@otherbench/core/domain/paths.js';
import type { LoadedAddon } from './loader.js';

/** What `GET /api/addons` says of each add-on. */
export interface AddonView {
  id: string;
  name: string;
  version: string | null;
  status: 'loaded' | 'failed';
  error: string | null;
  settingsPage: boolean;
}

/**
 * `GET /api/addons`: the add-ons found on this machine, loaded or not. Read-only: nothing here or anywhere else in
 * OtherBench installs, removes or switches on an add-on (docs/features/addons.md). Each loaded add-on's own routes are
 * mounted beside this by `app.ts`.
 */
export function addonsRoutes(list: () => readonly LoadedAddon[]): Hono {
  const app = new Hono();
  app.get('/', (c) =>
    c.json(
      list().map((a): AddonView => ({ id: a.id, name: a.name, version: a.version, status: a.status, error: a.error, settingsPage: a.status === 'loaded' && a.pagePath !== null }))
    )
  );
  return app;
}

/** The only file types a settings page is served as, by extension. Anything else is a 404. */
const PAGE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * `GET /addons/<id>/<path>`: a loaded add-on's settings page, shown in a frame under Settings → Add-ons. Files come
 * only from its checked page folder (containPath: no `..`, no link out), only of the types above, and with a policy
 * that lets only OtherBench's own pages (this server, or the desktop app's origins) frame them. Like the main UI's
 * files, they need no sign-in; the page's own API calls do.
 */
export function addonPageRoutes(list: () => readonly LoadedAddon[], frameOrigins: readonly string[]): Hono {
  const app = new Hono();
  const policy = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", `frame-ancestors ${["'self'", ...frameOrigins].join(' ')}`].join('; ');
  app.get('/:id/*', (c) => {
    const addon = list().find((a) => a.id === c.req.param('id') && a.status === 'loaded');
    if (!addon?.pagePath) return c.notFound();
    const prefix = `/addons/${addon.id}/`;
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname.slice(prefix.length));
    } catch {
      return c.notFound();
    }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const type = PAGE_TYPES[extname(rel).toLowerCase()];
    if (!type || rel.split(/[\\/]/).some((seg) => seg === '..' || seg === '.')) return c.notFound();
    let file: string;
    let body: Buffer;
    try {
      file = containPath(addon.pagePath, join(addon.pagePath, rel));
      if (!statSync(file).isFile()) return c.notFound();
      body = readFileSync(file);
    } catch {
      return c.notFound();
    }
    return c.body(new Uint8Array(body), 200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': policy, 'Cache-Control': 'no-store' });
  });
  return app;
}
