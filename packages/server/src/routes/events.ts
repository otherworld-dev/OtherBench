import { Hono } from 'hono';
import type { AppEventsHello } from '@grunt/core/types/events.js';
import type { Container } from '../container.js';
import { sseStream } from '../stream/sse.js';
import { eventView } from '../workspace-view.js';

/** How often an idle `GET /api/events` sends a comment, so proxies and the client's reader don't treat it as dead. */
export const EVENTS_KEEPALIVE_MS = 25_000;

/**
 * `GET /api/events` (v2 plan, Task 34): the app-wide event stream. Opens
 * with a `hello` carrying the pending approvals, then one unnamed event per
 * `AppEvent`. Subscribing before the hello is read means nothing that
 * happens in between is lost (it may also be in the hello; the client's
 * handling is idempotent).
 */
export function eventsRoutes(container: Container): Hono {
  const app = new Hono();

  app.get('/', () =>
    sseStream((sink) => {
      const unsubscribe = container.events?.subscribe((e) => sink.send(null, eventView(container, e))) ?? (() => {});
      const hello: AppEventsHello = {
        pendingApprovals: container.events?.pendingApprovals() ?? [],
        runningTurns: container.events?.runningTurns() ?? [],
      };
      sink.send('hello', hello);
      const keepalive = setInterval(() => sink.comment('keepalive'), EVENTS_KEEPALIVE_MS);
      return () => {
        clearInterval(keepalive);
        unsubscribe();
      };
    })
  );

  return app;
}
