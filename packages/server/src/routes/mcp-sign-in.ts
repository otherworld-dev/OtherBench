import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { SignInError } from '@grunt/tools/mcp/sign-in.js';
import type { Container } from '../container.js';

/** The redirect host: always loopback (spec 2026-10-12-mcp-oauth-design, "Redirect address"). If real providers refuse the IP literal, this one constant becomes 'localhost'. */
export const OAUTH_CALLBACK_HOST = '127.0.0.1';

export function oauthRedirectUri(port: number | null | undefined): string | null {
  return port ? `http://${OAUTH_CALLBACK_HOST}:${port}/oauth/callback` : null;
}

export function rethrowSignInError(err: unknown): never {
  if (err instanceof SignInError) throw new HTTPException(err.status, { message: err.message });
  throw err;
}

/**
 * Anything that isn't a SignInError may carry a URL or a code in its message,
 * so the log gets the server id and the error's name and nothing else, and the
 * browser gets fixed plain text (never the generic handler's `console.error(err)`).
 */
function rethrowSafely(serverId: string, err: unknown): never {
  if (err instanceof SignInError) return rethrowSignInError(err);
  console.error(`[grunt-server] MCP sign-in for ${serverId} failed: ${err instanceof Error ? err.name : 'unknown error'}`);
  throw new HTTPException(502, { message: "Couldn't sign in: something went wrong in Grunt. Start it again." });
}

function requireServer(container: Container, id: string): void {
  if (!container.store.mcpServers.get(id)) throw new HTTPException(404, { message: `MCP server "${id}" not found.` });
}

/**
 * Sign-in for http MCP servers (spec §5). Mounted on the authed API root, so
 * the bearer token and the cross-site write check apply as to every other
 * write. The redirect itself lands on the open `GET /oauth/callback`
 * (oauth-callback.ts); `complete` is the paste-back path for a browser on
 * another device, with the same checks.
 */
export function mcpSignInRoutes(container: Container, redirectUri: () => string | null): Hono {
  const app = new Hono();

  app.get('/mcp-servers/sign-in/redirect-uri', (c) => c.json({ redirectUri: redirectUri() }));

  app.post('/mcp-servers/:id/sign-in', async (c) => {
    const id = c.req.param('id');
    requireServer(container, id);
    const uri = redirectUri();
    if (!uri) throw new HTTPException(503, { message: "Grunt doesn't know which port it's on yet, so it can't sign in." });
    try {
      return c.json(await container.mcpManager.startSignIn(id, uri));
    } catch (err) {
      rethrowSafely(id, err);
    }
  });

  app.post('/mcp-servers/:id/sign-in/cancel', (c) => {
    const id = c.req.param('id');
    requireServer(container, id);
    container.mcpManager.cancelSignIn(id);
    return c.body(null, 204);
  });

  app.post('/mcp-servers/:id/sign-in/complete', async (c) => {
    const id = c.req.param('id');
    requireServer(container, id);
    const parsed: unknown = await c.req.json().catch(() => null);
    const body = (parsed && typeof parsed === 'object' ? parsed : {}) as { url?: unknown };
    if (typeof body.url !== 'string' || body.url.trim().length === 0) {
      throw new HTTPException(400, { message: 'Paste the address the sign-in ended on.' });
    }
    let ended: URL;
    try {
      ended = new URL(body.url.trim());
    } catch {
      throw new HTTPException(400, { message: "That isn't a web address. Copy the whole address from the browser's address bar." });
    }
    const state = ended.searchParams.get('state');
    if (!state) throw new HTTPException(400, { message: "That address has no sign-in state in it. Copy the whole address from the browser's address bar." });
    try {
      await container.mcpManager.completeSignIn({
        serverId: id,
        state,
        code: ended.searchParams.get('code') ?? undefined,
        error: ended.searchParams.get('error') ?? undefined,
      });
    } catch (err) {
      rethrowSafely(id, err);
    }
    return c.json({ signedIn: true });
  });

  app.post('/mcp-servers/:id/sign-out', async (c) => {
    const id = c.req.param('id');
    requireServer(container, id);
    await container.mcpManager.signOut(id);
    return c.body(null, 204);
  });

  return app;
}
