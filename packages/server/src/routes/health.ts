import { Hono } from 'hono';

/**
 * `GET /api/health` -- a small, unauthenticated liveness probe. Later tasks
 * and the desktop shell's startup handshake need to be able to ask "is the
 * server up yet" before they necessarily have (or need) a bearer token, so
 * this route is mounted outside the auth gate in app.ts on purpose; it
 * returns nothing sensitive.
 *
 * `platform` (`process.platform`, e.g. `"win32"`, `"linux"`, `"darwin"`) is
 * included so the web client can validate a chat's workspace root against
 * the SERVER's own path convention, not the browser's -- a workspace root is
 * a filesystem path the server resolves (`containPath`,
 * packages/core/src/domain/paths.ts), so "is this a native absolute path"
 * only has one correct answer, and it depends on what OS the server -- not
 * necessarily the machine the browser happens to run on -- is running on.
 *
 * `computerUse` says whether the computer tool can be offered on this server
 * (the desktop shell on Windows said hello with it on); the profile editor
 * only shows the switch when it can.
 */
export function healthRoutes(computerUse: () => boolean = () => false): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString(), platform: process.platform, computerUse: computerUse() }));

  return app;
}
