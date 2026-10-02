import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

/**
 * Pieces of `grunt serve` that only the desktop shell turns on. Browser
 * mode (`npm run serve` + a browser) never mounts the CORS allowlist, and
 * keeps the same-origin `/api` it always had.
 */

/**
 * The handshake the desktop shell reads: with `--announce`, this is the
 * first and only thing written to stdout, once the port is bound. Every log
 * line goes to stderr in that mode so nothing can get ahead of it.
 */
export function announceLine(port: number): string {
  return `${JSON.stringify({ port })}\n`;
}

/**
 * DNS-rebinding defence for a loopback-bound server. A web page on any
 * origin can resolve its own hostname to 127.0.0.1 and then talk to this
 * port as "same origin" -- but the browser still sends that hostname in
 * `Host`. Only the loopback names this server can actually be reached by
 * are accepted. `port` is read per request because with `--port 0` it isn't
 * known until after the app is built.
 */
export function hostCheck(port: () => number): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host')?.toLowerCase();
    const p = port();
    const allowed = [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`];
    if (!host || !allowed.includes(host)) {
      return c.json({ error: `Host "${host ?? ''}" is not allowed; this server only answers on ${allowed[0]}.` }, 421);
    }
    await next();
  };
}

/**
 * CORS for the desktop shell's own webview origin and nothing else. The
 * function form is deliberate: it can never fall back to `*` or to the
 * first listed origin, whatever Hono's default for an array becomes.
 * Mounted ahead of the auth gate, so a preflight (which never carries
 * `Authorization`) gets its answer instead of a 401.
 */
export function corsAllowlist(origins: string[]): MiddlewareHandler {
  const allowed = new Set(origins);
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    maxAge: 600,
  });
}

/**
 * Orphan protection: the desktop shell holds this process's stdin open for
 * as long as it lives. If the shell exits -- cleanly or not -- the pipe
 * closes and the server follows it, rather than lingering with the database
 * lock held. `resume()` is needed because a paused stream never emits `end`.
 */
export function exitOnStdinClose(stdin: NodeJS.ReadableStream, onClose: () => void): void {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    onClose();
  };
  stdin.on('end', fire);
  stdin.on('close', fire);
  stdin.on('error', fire);
  stdin.resume();
}
