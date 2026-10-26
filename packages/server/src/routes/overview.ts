import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Container } from '../container.js';
import { OverviewError, type OverviewService } from '../overview/service.js';

/**
 * The Overview (spec 2026-10-26-overview-design): what needs the user across
 * every app, plus the tick-offs that clear it. A user action on this machine,
 * so it is mounted on the authed API only and never on the peer listener.
 */
export function overviewRoutes(container: Container): Hono {
  const app = new Hono();

  function service(): OverviewService {
    if (!container.overview) throw new HTTPException(503, { message: 'The Overview is not available on this server.' });
    return container.overview;
  }

  app.get('/', (c) => c.json(service().view()));

  app.post('/refresh', async (c) => {
    const overview = service();
    await overview.refresh();
    return c.json(overview.view());
  });

  app.post('/issues/:appId/:n/tick', (c) => {
    const overview = service();
    const appId = c.req.param('appId');
    if (!container.store.apps.get(appId)) throw new HTTPException(404, { message: `No app "${appId}".` });
    const raw = c.req.param('n');
    const number = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (!Number.isSafeInteger(number) || number < 1) throw new HTTPException(400, { message: 'The issue number must be a positive whole number.' });
    try {
      overview.tickIssue(appId, number);
    } catch (err) {
      if (err instanceof OverviewError) return c.json({ error: err.message, code: err.code }, 409);
      throw err;
    }
    return c.json(overview.view());
  });

  app.post('/tick-older', async (c) => {
    const overview = service();
    const body = (await c.req.json().catch(() => ({}))) as { before?: unknown };
    if (typeof body.before !== 'number' || !Number.isFinite(body.before)) {
      throw new HTTPException(400, { message: '"before" must be a finite number (milliseconds).' });
    }
    // A future cut-off would tick chats whose latest reply is newer than the moment of ticking.
    return c.json(overview.tickOlder(Math.min(body.before, Date.now())));
  });

  return app;
}
