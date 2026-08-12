import { Hono } from 'hono';

/**
 * `GET /api/health` -- a small, unauthenticated liveness probe. Later tasks
 * and the desktop shell's startup handshake need to be able to ask "is the
 * server up yet" before they necessarily have (or need) a bearer token, so
 * this route is mounted outside the auth gate in app.ts on purpose; it
 * returns nothing sensitive.
 */
export function healthRoutes(): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

  return app;
}
