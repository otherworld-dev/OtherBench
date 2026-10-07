import type { MiddlewareHandler } from 'hono';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Refuses API writes sent by a page on another site (Deck #897). In browser
 * mode there is no token, and every write route reads its body as JSON
 * whatever its type, so without this a hidden `text/plain` form on any site
 * the user visits could create a connection or a profile. Reads are left
 * alone: CORS already keeps another site from reading the answer.
 *
 * A write is let through when the browser says it's same-origin
 * (`Sec-Fetch-Site`, which a page can't set: this also covers `npm run dev`
 * through Vite's proxy), when its `Origin` is this server's own or one of
 * `allowedOrigins` (the desktop webview's), or when it carries neither
 * header, as clients that are no browser (curl, scripts, tests) send it.
 * Anything else a browser sends, an opaque `null` origin included, is refused.
 */
export function refuseCrossSiteWrites(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    if (WRITES.has(c.req.method)) {
      const site = c.req.header('sec-fetch-site');
      const origin = c.req.header('origin');
      const host = c.req.header('host')?.toLowerCase();
      const own = origin !== undefined && (allowed.has(origin) || (host !== undefined && origin.toLowerCase() === `http://${host}`));
      const browserSaysSameOrigin = site === 'same-origin' || site === 'none';
      const noBrowser = origin === undefined && site === undefined;
      if (!own && !browserSaysSameOrigin && !noBrowser) {
        return c.json({ error: "Refused: this request came from another site's page. Grunt's API only takes changes from its own window." }, 403);
      }
    }
    await next();
  };
}
