import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Container } from '../container.js';

/**
 * Computer use for the web app (spec 2026-10-12-computer-use-design section
 * 7). Mounted on this machine's own authed API only, never on the peer
 * listener: control is local to the machine that runs the turn.
 *
 * `POST /api/chats/:id/computer/stop`: the thread banner's Stop. Ends the
 * chat's control session and cancels its running reply. Stopping comes
 * first and never depends on the chat's row: a chat that holds the computer
 * is stopped even when its row is already gone (its profile was deleted
 * under it, say). The answer is then as for any chat route: 204, whether or
 * not a session was running and on a server with no driver; 404 for a chat
 * that doesn't exist.
 *
 * `GET /api/computer/status`: `{ computerUse }`, whether the computer tool
 * can be offered on this server (the desktop shell on Windows said hello
 * with it on); the profile editor only shows the switch when it can. It is
 * here, behind the auth gate, and not on the open health route: that this
 * machine offers desktop control is not for a caller who has not signed in.
 * A server with no driver, and a driver that can't say, answer `false`.
 */
export function computerRoutes(container: Container): Hono {
  const app = new Hono();

  app.post('/chats/:id/computer/stop', async (c) => {
    const id = c.req.param('id');
    const exists = Boolean(container.store.chats.get(id));
    if (exists || container.computer?.holder() === id) await container.computer?.stop(id);
    if (!exists) throw new HTTPException(404, { message: `Chat "${id}" not found.` });
    return c.body(null, 204);
  });

  app.get('/computer/status', (c) => c.json({ computerUse: container.computer?.available() === true }));

  return app;
}
