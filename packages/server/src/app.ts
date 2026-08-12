import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Container } from './container.js';
import { chatsRoutes, searchRoutes } from './routes/chats.js';
import { connectionsRoutes } from './routes/connections.js';
import { healthRoutes } from './routes/health.js';
import { modelsRoutes } from './routes/models.js';
import { profilesRoutes } from './routes/profiles.js';
import { turnsRoutes } from './routes/turns.js';

export interface AppOptions {
  /**
   * When set, every `/api/*` route EXCEPT `/api/health` requires
   * `Authorization: Bearer <token>` (see routes/health.ts for why health is
   * exempt). Unset means no auth is enforced at all -- safe only when
   * `grunt serve` is bound to loopback, which `cli.ts`'s security gate
   * enforces before this app is ever constructed for a non-loopback host.
   */
  token?: string | null;
}

export function createApp(container: Container, options: AppOptions = {}): Hono {
  const app = new Hono();

  app.route('/api', healthRoutes());

  const authed = new Hono();
  if (options.token) {
    const token = options.token;
    authed.use('*', async (c, next) => {
      const header = c.req.header('Authorization');
      if (header !== `Bearer ${token}`) {
        throw new HTTPException(401, { message: 'Missing or invalid bearer token.' });
      }
      await next();
    });
  }
  authed.route('/connections', connectionsRoutes(container));
  authed.route('/models', modelsRoutes(container));
  authed.route('/profiles', profilesRoutes(container));
  authed.route('/chats', chatsRoutes(container));
  // turnsRoutes defines full paths under both /chats/... and /messages/...
  // (a turn spans both namespaces: POST .../turns, GET .../stream, POST
  // .../head live under /chats/:id/..., while POST .../cancel lives under
  // /messages/:id/...) so it mounts at the authed app's own root rather
  // than a single fixed prefix like the routers above. It has no path
  // collisions with chatsRoutes: that owns /chats, /chats/:id,
  // /chats/:id/messages; this owns /chats/:id/turns, /chats/:id/stream,
  // /chats/:id/head, /messages/:id/cancel.
  authed.route('/', turnsRoutes(container));
  authed.route('/', searchRoutes(container));
  app.route('/api', authed);

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error('[grunt-server] unhandled error:', err);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  return app;
}
