import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Container } from '../container.js';
import { codeCall } from '../code/route-errors.js';
import type { OverviewService } from '../overview/service.js';

/**
 * The Overview (spec 2026-10-26-overview-design): what needs the user across
 * every app, plus the tick-offs and GitHub's Done that clear it (spec
 * 2026-10-29-github-inbox-design). A user action on this machine, so it is
 * mounted on the authed API only and never on the peer listener.
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

  /** A notification thread id from the path: digits only, since it goes into a GitHub API path. */
  function threadIdOf(raw: string): string {
    if (!/^\d+$/.test(raw)) throw new HTTPException(400, { message: 'The notification id must be a number.' });
    return raw;
  }

  // GitHub's Done and mark-read on one notification; gh's errors answer as the apps routes' do.
  app.post('/notifications/:id/done', async (c) => {
    const overview = service();
    const id = threadIdOf(c.req.param('id'));
    await codeCall(() => overview.markDone(id));
    return c.json(overview.view());
  });

  app.post('/notifications/:id/read', async (c) => {
    const overview = service();
    const id = threadIdOf(c.req.param('id'));
    await codeCall(() => overview.markRead(id));
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
