import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PushPrefs } from '@otherbench/core/ports/store.js';
import { sessionFromCookie } from '../remote/auth.js';
import type { RemoteAccess } from '../remote/index.js';
import { DEFAULT_PUSH_PREFS, PushInputError, type PushService } from '../push/service.js';

/** `GET /api/push`: whether this browser can turn on push, the key to subscribe with, and what it has now. */
export interface PushStatusBody {
  available: boolean;
  /** Why not, when it isn't. */
  reason?: string;
  publicKey?: string;
  subscribed: boolean;
  prefs: PushPrefs | null;
}

const NOT_REMOTE = 'Phone notifications work only when OtherBench runs with remote access (otherbench serve --public-url).';
const NO_SESSION = 'Only a browser signed in with the password can turn on notifications.';

function prefsFrom(value: unknown, fallback: PushPrefs): PushPrefs | string {
  if (value === undefined) return fallback;
  if (typeof value !== 'object' || value === null) return '"prefs" must be an object.';
  const v = value as Record<string, unknown>;
  const out = { ...fallback };
  for (const key of ['approvals', 'replies', 'scheduled'] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== 'boolean') return `"prefs.${key}" must be true or false.`;
    out[key] = v[key];
  }
  return out;
}

/**
 * `/api/push/*` (behind the gate): Web Push for this signed-in device. Each
 * route works on the caller's own remote session, found from its cookie, so
 * a device can only see and change its own subscription; the bearer token
 * (the desktop app) has no device to notify. In open and token modes, and
 * with no `PushService`, it says push isn't available and refuses writes.
 * The writes are under `/api`, so the cross-site write check covers them.
 */
export function pushRoutes(push: PushService | null, remote: RemoteAccess | null): Hono {
  const app = new Hono();
  const limit = bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: 'Request too large.' }, 413) });

  /** The caller's session id, or a response saying why there's none. */
  const sessionOf = (c: Context): string | Response => {
    if (!push || !remote) return c.json({ error: NOT_REMOTE }, 404);
    // A request with a bearer header is the desktop app: never a cookie session, as in the gate.
    if (c.req.header('Authorization') !== undefined) return c.json({ error: NO_SESSION }, 409);
    const found = sessionFromCookie(c, remote);
    return found ? found.session.id : c.json({ error: NO_SESSION }, 409);
  };

  app.get('/', async (c) => {
    if (!push || !remote) return c.json({ available: false, reason: NOT_REMOTE, subscribed: false, prefs: null } satisfies PushStatusBody);
    const id = sessionOf(c);
    if (id instanceof Response) return c.json({ available: false, reason: NO_SESSION, subscribed: false, prefs: null } satisfies PushStatusBody);
    const sub = push.subscription(id);
    return c.json({ available: true, publicKey: await push.publicKey(), subscribed: sub !== null, prefs: sub?.prefs ?? null } satisfies PushStatusBody);
  });

  app.put('/subscription', limit, async (c) => {
    const id = sessionOf(c);
    if (id instanceof Response) return id;
    const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; prefs?: unknown } | null;
    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh;
    const auth = body?.keys?.auth;
    if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') return c.json({ error: 'Send the browser\'s subscription: "endpoint" and "keys" {p256dh, auth}.' }, 400);
    const prefs = prefsFrom(body?.prefs, push!.subscription(id)?.prefs ?? DEFAULT_PUSH_PREFS);
    if (typeof prefs === 'string') return c.json({ error: prefs }, 400);
    try {
      const saved = await push!.subscribe(id, { endpoint, p256dh, auth, prefs });
      return c.json({ subscribed: true, prefs: saved.prefs });
    } catch (err) {
      if (err instanceof PushInputError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.patch('/subscription', limit, async (c) => {
    const id = sessionOf(c);
    if (id instanceof Response) return id;
    const existing = push!.subscription(id);
    if (!existing) return c.json({ error: 'Notifications are off on this device.' }, 404);
    const body = (await c.req.json().catch(() => null)) as { prefs?: unknown } | null;
    const prefs = prefsFrom(body?.prefs, existing.prefs);
    if (typeof prefs === 'string') return c.json({ error: prefs }, 400);
    const saved = push!.setPrefs(id, prefs);
    return c.json({ subscribed: saved !== null, prefs: saved?.prefs ?? null });
  });

  app.delete('/subscription', (c) => {
    const id = sessionOf(c);
    if (id instanceof Response) return id;
    push!.unsubscribe(id);
    return c.body(null, 204);
  });

  app.post('/test', async (c) => {
    const id = sessionOf(c);
    if (id instanceof Response) return id;
    const result = await push!.sendTest(id);
    if (result === 'none') return c.json({ error: 'Notifications are off on this device.' }, 404);
    return c.json({ result });
  });

  // The page says whether it is showing, so a device looking at OtherBench isn't also sent a push.
  app.post('/active', limit, async (c) => {
    const id = sessionOf(c);
    if (id instanceof Response) return id;
    const body = (await c.req.json().catch(() => null)) as { visible?: unknown } | null;
    if (typeof body?.visible !== 'boolean') return c.json({ error: '"visible" must be true or false.' }, 400);
    push!.setActive(id, body.visible);
    return c.body(null, 204);
  });

  return app;
}
