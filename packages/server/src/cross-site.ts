import type { Context, MiddlewareHandler } from 'hono';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const refused = (c: Context): Response =>
  c.json({ error: "Refused: this request came from another site's page, or from a form, page or plugin. Grunt's API only takes changes from its own window." }, 403);

/**
 * Refuses API writes sent by a page on another site (Deck #897). In browser
 * mode there is no token, and every write route reads its body as JSON
 * whatever its type, so without this a hidden `text/plain` form on any site
 * the user visits could create a connection or a profile. Reads are left
 * alone: CORS already keeps another site from reading the answer.
 *
 * A write is let through when the browser says it's same-origin
 * (`Sec-Fetch-Site`, which a page can't set: this also covers `npm run dev`
 * through Vite's proxy), when its `Origin` is this server's own (with the
 * scheme it was reached by) or one of `allowedOrigins` (the desktop webview's,
 * and the public URLs in sign-in mode), or when it carries neither
 * header, as clients that are no browser (curl, scripts, tests) send it.
 * Anything else a browser sends, an opaque `null` origin included, is refused.
 */
export function refuseCrossSiteWrites(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    if (WRITES.has(c.req.method)) {
      // Grunt's UI writes only with fetch (Sec-Fetch-Dest: empty), never a
      // form, a page load or a plugin: those are refused even from this
      // origin, which serves PDFs unsandboxed (Deck #901). Not the Referer:
      // /view/ pages send none (Referrer-Policy: no-referrer).
      const dest = c.req.header('sec-fetch-dest');
      if (c.req.header('sec-fetch-mode') === 'navigate' || (dest !== undefined && dest !== 'empty')) return refused(c);
      const site = c.req.header('sec-fetch-site');
      const origin = c.req.header('origin');
      const host = c.req.header('host')?.toLowerCase();
      // This server's own origin with the scheme it was reached by: https on
      // a TLS socket (@hono/node-server builds the URL from Host and the
      // socket). `allowed` adds the desktop webview's and, in sign-in mode,
      // the public URLs' (which also covers a TLS proxy in front).
      const scheme = new URL(c.req.url).protocol;
      const own = origin !== undefined && (allowed.has(origin) || (host !== undefined && origin.toLowerCase() === `${scheme}//${host}`));
      const browserSaysSameOrigin = site === 'same-origin' || site === 'none';
      const noBrowser = origin === undefined && site === undefined;
      if (!own && !browserSaysSameOrigin && !noBrowser) return refused(c);
    }
    await next();
  };
}
