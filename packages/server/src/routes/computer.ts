import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Container } from '../container.js';

/**
 * `POST /api/chats/:id/computer/stop` (spec 2026-10-12-computer-use-design
 * section 7): the thread banner's Stop. Ends the chat's control session and
 * cancels its running reply. Answers 204 whether or not a session was
 * running, and on a server with no driver; 404 for a chat that doesn't exist.
 * Mounted on this machine's own authed API only, never on the peer listener:
 * control is local to the machine that runs the turn.
 */
export function computerRoutes(container: Container): Hono {
  const app = new Hono();

  app.post('/chats/:id/computer/stop', async (c) => {
    const id = c.req.param('id');
    if (!container.store.chats.get(id)) throw new HTTPException(404, { message: `Chat "${id}" not found.` });
    await container.computer?.stop(id);
    return c.body(null, 204);
  });

  return app;
}
