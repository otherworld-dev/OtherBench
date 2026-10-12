import { Hono, type Context } from 'hono';
import { SignInError } from '@grunt/tools/mcp/sign-in.js';
import type { Container } from '../container.js';

const PAGE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(c: Context, status: 200 | 400 | 500, title: string, message: string): Response {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)} - Grunt</title>` +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}h1{font-size:1.25rem}</style>' +
    `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return c.html(html, status, PAGE_HEADERS);
}

/**
 * `GET /oauth/callback` (spec 2026-10-12-mcp-oauth-design §5): where a
 * provider sends the browser back. Outside `/api` and with no bearer token
 * or session (the system browser has none); the Host check still applies. It
 * can only finish a flow whose 256-bit `state` the caller already knows,
 * once, within 10 minutes. The URL holds the code, so it is never logged.
 */
export function oauthCallbackRoutes(container: Container): Hono {
  const app = new Hono();
  app.get('/callback', async (c) => {
    const state = c.req.query('state');
    if (!state) return page(c, 400, "Couldn't sign in", 'This address is missing its sign-in state. Start the sign-in again from Grunt.');
    try {
      const { serverName } = await container.mcpManager.completeSignIn({ state, code: c.req.query('code'), error: c.req.query('error') });
      return page(c, 200, 'Signed in', `Signed in to ${serverName}. You can close this tab and go back to Grunt.`);
    } catch (err) {
      if (err instanceof SignInError) return page(c, 400, "Couldn't sign in", err.message);
      console.error('[grunt-server] an MCP sign-in callback failed unexpectedly.');
      return page(c, 500, "Couldn't sign in", 'Something went wrong in Grunt. Start the sign-in again from Grunt.');
    }
  });
  return app;
}
