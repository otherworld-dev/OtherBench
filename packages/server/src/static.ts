import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

export interface StaticOptions {
  /** Absolute path to the built web bundle's directory (packages/web's `vite build` output). */
  webDistDir: string;
}

/**
 * Shown at `/` (and any other non-`/api` path) when `webDistDir` has no
 * `index.html` -- i.e. `npm run build` hasn't produced the web bundle yet.
 * The API must keep working either way (decision #2, task 19/20 brief):
 * this is a diagnostic page, not a failure.
 */
function placeholderHtml(webDistDir: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OtherBench</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; color: #1a1d21; }
  code { background: #eef0f2; padding: 0.1em 0.4em; border-radius: 3px; }
  @media (prefers-color-scheme: dark) { body { color: #e7e8ea; background: #17181b; } code { background: #2c2f34; } }
</style>
</head>
<body>
  <h1>OtherBench server is running</h1>
  <p>The API is live at <code>/api/*</code> (try <code>/api/health</code>), but no built web bundle was found at:</p>
  <p><code>${webDistDir}</code></p>
  <p>Run <code>npm run build</code> from the repo root to build <code>@otherbench/web</code>, then restart <code>otherbench serve</code>.</p>
</body>
</html>`;
}

/**
 * Mounts the built web app at `/` and every other non-`/api` path, so
 * `otherbench serve` serves the whole product from one origin/port: the SPA at
 * `/`, the API at `/api/*`. Must be called AFTER the `/api` routes are
 * already mounted on `app` (see app.ts) -- not because Hono's router would
 * otherwise misroute a matched `/api/...` path (route specificity already
 * handles that), but because this function's own fallback/placeholder
 * logic explicitly re-checks the path itself: an unmatched `/api/...`
 * request must keep falling through to Hono's plain 404, never to the SPA
 * index page or the placeholder, so a client can tell "no such endpoint"
 * apart from "here's the app shell" (see app.test.ts's existing 404 test).
 *
 * When the bundle is missing (`webDistDir` has no `index.html` -- e.g.
 * running from source before `npm run build`), every non-API path serves a
 * clear placeholder instead of crashing or serving nothing (decision #2).
 */
export function mountStatic(app: Hono, { webDistDir }: StaticOptions): void {
  const bundleExists = existsSync(join(webDistDir, 'index.html'));
  const placeholder = placeholderHtml(webDistDir);

  // Only constructed when the bundle actually exists -- `serveStatic()`
  // itself `existsSync`-checks its root at construction time and logs a
  // warning if it's missing, which would otherwise spam the console on
  // every request in the (common, expected) dev-without-a-build case that
  // the placeholder branch below already handles cleanly.
  const serveAsset = bundleExists ? serveStatic({ root: webDistDir }) : null;
  // SPA fallback: any GET that doesn't match a real built asset (a
  // client-side route like `/chats/abc`) still gets `index.html`, so
  // client-side routing (if any is ever added) and a hard refresh both work.
  const serveIndex = bundleExists ? serveStatic({ root: webDistDir, path: 'index.html' }) : null;

  app.use('*', async (c, next) => {
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
      await next();
      return;
    }
    // No other site may frame OtherBench's UI (spec 2026-10-12-remote-access §3):
    // that would let it trick a click on an approval button. Every mode. The
    // viewer's iframes load /view/, which sets its own headers.
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    c.header('X-Frame-Options', 'DENY');
    if (!serveAsset || !serveIndex) {
      return c.html(placeholder);
    }
    // Composed by hand (rather than nesting `next` callbacks) so the inner
    // "not found" continuation stays typed as Hono's `Next` (`() =>
    // Promise<void>`) throughout: `serveAsset` tries a real built file
    // first; if it returns nothing, `serveIndex` (the SPA fallback) gets a
    // turn; only if that ALSO finds nothing does the outer `next` run.
    const assetResponse = await serveAsset(c, async () => {});
    if (assetResponse) return assetResponse;
    return serveIndex(c, next);
  });
}
