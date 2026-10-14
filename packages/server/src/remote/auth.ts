import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { DEVICE_COOKIE } from './devices.js';
import type { RemoteAccess, RemoteTls } from './index.js';
import { tooManyMessage } from './limiter.js';
import { MAX_PASSWORD_LENGTH, passwordProblem, verifyPassword, type PasswordRecord } from './password.js';
import { REMEMBER_MS, type Session, type SessionStore } from './sessions.js';

/** Sent as `__Host-grunt_session` (Hono's `prefix: 'host'`): Secure, Path=/, no Domain. */
export const SESSION_COOKIE = 'grunt_session';
const SIGN_IN = 'Sign in to Grunt.';
const BAD_TOKEN = 'Missing or invalid bearer token.';
/** `Sec-Fetch-Site` values the cookie counts for; absent (old browsers) counts too. */
const COOKIE_SITES = new Set(['same-origin', 'none']);

export interface AuthOptions {
  token: string | null;
  /** Set only in sign-in mode (`--public-url`). */
  remote: RemoteAccess | null;
}

export interface AuthStatusBody {
  mode: 'open' | 'token' | 'login';
  signedIn: boolean;
  caDownload?: boolean;
  session?: { expiresAt: number; remember: boolean };
  remote?: { publicUrls: string[]; tls: Omit<RemoteTls, 'caDer'>; trustProxies: string[] };
}

/** `Authorization` against `Bearer <token>`, in constant time over SHA-256 digests (same outcome as `===`). */
export function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(`Bearer ${token}`).digest();
  return timingSafeEqual(a, b);
}

const cookieSiteAllowed = (c: Context): boolean => {
  const site = c.req.header('sec-fetch-site');
  return site === undefined || COOKIE_SITES.has(site);
};

/**
 * The session the cookie names, if it may be used: the browser says the
 * request is same-origin (so a sibling subdomain or a sandboxed `/view/`
 * page can't ride it), it exists, it hasn't expired, and it was made under
 * the current password.
 */
export function sessionFromCookie(c: Context, remote: RemoteAccess): { id: string; session: Session } | null {
  const id = getCookie(c, SESSION_COOKIE, 'host');
  if (!id || !cookieSiteAllowed(c)) return null;
  const session = remote.sessions.get(id);
  if (!session) return null;
  if (session.epoch !== remote.passwords.epoch()) {
    remote.sessions.end(id);
    return null;
  }
  return { id, session };
}

function setSessionCookie(c: Context, id: string, remember: boolean): void {
  setCookie(c, SESSION_COOKIE, id, {
    prefix: 'host',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    ...(remember ? { maxAge: REMEMBER_MS / 1000 } : {}),
  });
}

function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { prefix: 'host', path: '/', secure: true });
}

/** A remembered-device cookie for a browser that just proved the password under `epoch` (see `devices.ts`). */
function setDeviceCookie(c: Context, remote: RemoteAccess, epoch: string): void {
  const { value, maxAgeSec } = remote.devices.issue(epoch);
  setCookie(c, DEVICE_COOKIE, value, { prefix: 'host', path: '/', secure: true, httpOnly: true, sameSite: 'Strict', maxAge: maxAgeSec });
}

function clearDeviceCookie(c: Context): void {
  deleteCookie(c, DEVICE_COOKIE, { prefix: 'host', path: '/', secure: true });
}

/**
 * The id of this request's remembered-device cookie when it is valid (its
 * HMAC, expiry and password epoch checked, judged same-origin only like the
 * session cookie) and the limiter hasn't locked that id; else null, and the
 * attempt is an ordinary one.
 */
function rememberedDevice(c: Context, remote: RemoteAccess): string | null {
  if (!cookieSiteAllowed(c)) return null;
  const id = remote.devices.idOf(getCookie(c, DEVICE_COOKIE, 'host'), remote.passwords.epoch());
  if (id === null || !remote.limiter.checkDevice(id).ok) return null;
  return id;
}

/**
 * A session-authenticated event stream (`/api/events`, `/api/chats/:id/stream`
 * and the streams forwarded from a paired machine) closes when its session
 * ends: cancelling the original body runs `sseStream`'s cleanup.
 */
function endWithSession(c: Context, remote: RemoteAccess, id: string): void {
  const sessions: SessionStore = remote.sessions;
  const res = c.res;
  if (!res.body || !(res.headers.get('Content-Type') ?? '').startsWith('text/event-stream')) return;
  // The session may have ended while the handler was still opening the stream
  // (a forwarded stream awaits a fetch first); a listener added now would
  // never fire, so refuse the stream instead.
  const session = sessions.get(id);
  if (!session || session.epoch !== remote.passwords.epoch()) {
    void res.body.cancel().catch(() => {});
    c.res = c.json({ error: SIGN_IN }, 401);
    return;
  }
  const reader = res.body.getReader();
  let unsubscribe: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = sessions.onEnd(id, () => {
        unsubscribe();
        void reader.cancel().catch(() => {});
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          unsubscribe();
          try {
            controller.close();
          } catch {
            // closed by the session ending
          }
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        unsubscribe();
        try {
          controller.error(err);
        } catch {
          // already closed
        }
      }
    },
    cancel(reason) {
      unsubscribe();
      return reader.cancel(reason);
    },
  });
  c.res = new Response(body, { status: res.status, headers: res.headers });
}

/**
 * The gate on every `/api` route but health and `/api/auth` (spec §3).
 * A bearer header is checked first and alone; else, in sign-in mode, the
 * session cookie; else 401. Open mode mounts no gate.
 */
export function authGate({ token, remote }: AuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (header !== undefined) {
      if (token !== null && tokenMatches(header, token)) {
        await next();
        return;
      }
      throw new HTTPException(401, { message: remote ? SIGN_IN : BAD_TOKEN });
    }
    if (remote) {
      const found = sessionFromCookie(c, remote);
      if (found) {
        await next();
        endWithSession(c, remote, found.id);
        return;
      }
      if (getCookie(c, SESSION_COOKIE, 'host') !== undefined && cookieSiteAllowed(c)) clearSessionCookie(c);
      return c.json({ error: SIGN_IN }, 401);
    }
    throw new HTTPException(401, { message: BAD_TOKEN });
  };
}

const isJson = (c: Context): boolean => (c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json');

function tooMany(c: Context, retryAfterSec: number, message: string): Response {
  return c.json({ error: message }, 429, { 'Retry-After': String(retryAfterSec) });
}

/** 429 when this attempt's lock is on: its device id's for a remembered device, else its address's. */
function lockedOut(c: Context, remote: RemoteAccess, address: string, device: string | null): Response | null {
  const limited = device !== null ? remote.limiter.checkDevice(device) : remote.limiter.check(address);
  if (limited.ok) return null;
  remote.limiter.note('locked', address);
  return tooMany(c, limited.retryAfterSec, tooManyMessage(limited.retryAfterSec));
}

/** "in 5 seconds", "in a minute", "in 3 minutes". */
function inTime(sec: number): string {
  if (sec <= 1) return 'in a second';
  if (sec < 60) return `in ${sec} seconds`;
  const minutes = Math.ceil(sec / 60);
  return minutes === 1 ? 'in a minute' : `in ${minutes} minutes`;
}

/**
 * Runs one password check under the limiter (`limiter.ts`): 429 while
 * locked, refused by the budget or with too many waiting; 503 when there's
 * no password file; `wrongStatus` for a wrong password. The record on
 * success. The wait (delay, token, check slot) comes after the body is read
 * and before the password file is read or scrypt runs, so a right password
 * waits as long as a wrong one and nothing is held meanwhile. A browser
 * with a valid remembered-device cookie spends a device token instead and
 * skips the delay, and is locked by its cookie's id instead of its address;
 * its HMAC is checked here, before anything waits, and a forged, expired
 * or locked one counts as no cookie.
 *
 * The one place a password is verified: `/login` and `/password` both come
 * through here, `verifyPassword` needs the `Granted` only `admit` returns,
 * and `test/remote/single-verifier.test.ts` backs that up. Every granted
 * check is released with its outcome, so one that ends without a password
 * check (locked while waiting) is charged as a failure.
 */
async function checkPassword(c: Context, remote: RemoteAccess, address: string, password: string, wrongStatus: 401 | 403): Promise<PasswordRecord | Response> {
  const device = rememberedDevice(c, remote);
  const locked = lockedOut(c, remote, address, device);
  if (locked) return locked;
  const admitted = await remote.limiter.admit(address, { device, signal: c.req.raw.signal });
  if (admitted.kind === 'busy') {
    const message =
      admitted.why === 'budget'
        ? `Too many sign-in attempts on this server right now. Try again ${inTime(admitted.retryAfterSec)}.`
        : 'Sign-in is busy. Try again in a few seconds.';
    return tooMany(c, admitted.retryAfterSec, message);
  }
  // Nobody reads this: the client has gone.
  if (admitted.kind === 'gone') return c.body(null, 408);
  const { granted } = admitted;
  try {
    // Other attempts with this address or device may have locked it while this one waited.
    const lockedSince = lockedOut(c, remote, address, device);
    if (lockedSince) return lockedSince;
    let record: PasswordRecord | null;
    try {
      record = remote.passwords.read();
    } catch {
      record = null;
    }
    if (!record) {
      granted.release('unavailable');
      remote.limiter.note('no-password-file', address);
      return c.json({ error: 'No password is set on this server. Run "grunt password" on it.' }, 503);
    }
    if (await verifyPassword(password, record, granted)) {
      granted.release('right');
      return record;
    }
    granted.release('wrong');
    return c.json({ error: wrongStatus === 401 ? 'Wrong password.' : 'The current password is wrong.' }, wrongStatus);
  } finally {
    // Anything that didn't say otherwise above ended without a password check.
    granted.release('unchecked');
  }
}

const publicTls = ({ caDer: _caDer, ...rest }: RemoteTls): Omit<RemoteTls, 'caDer'> => rest;

/**
 * `/api/auth/*`, mounted in every mode before the gated routes (spec §3).
 * The writes are under `/api`, so `refuseCrossSiteWrites` already stops
 * another site signing the browser in or out.
 */
export function authRoutes({ token, remote }: AuthOptions): Hono {
  const app = new Hono();

  app.get('/status', (c) => {
    if (!remote) {
      if (!token) return c.json({ mode: 'open', signedIn: true } satisfies AuthStatusBody);
      return c.json({ mode: 'token', signedIn: tokenMatches(c.req.header('Authorization'), token) } satisfies AuthStatusBody);
    }
    const bearer = token !== null && tokenMatches(c.req.header('Authorization'), token);
    // Like the gate: a header present is judged alone, the cookie isn't tried.
    const found = bearer || c.req.header('Authorization') !== undefined ? null : sessionFromCookie(c, remote);
    const body: AuthStatusBody = { mode: 'login', signedIn: bearer || found !== null, caDownload: remote.tls.mode === 'auto' };
    if (found) body.session = { expiresAt: found.session.expiresAt, remember: found.session.remember };
    if (body.signedIn) body.remote = { publicUrls: remote.publicOrigins, tls: publicTls(remote.tls), trustProxies: remote.trustProxies };
    return c.json(body);
  });

  if (!remote) {
    app.post('/*', (c) => c.json({ error: 'Sign-in is off on this server.' }, 404));
    return app;
  }

  const limit = bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: 'Request too large.' }, 413) });
  const userAgentOf = (c: Context): string | null => c.req.header('User-Agent')?.slice(0, 200) ?? null;

  app.post('/login', limit, async (c) => {
    if (!isJson(c)) return c.json({ error: 'Send the request as JSON.' }, 415);
    const body = (await c.req.json().catch(() => null)) as { password?: unknown; remember?: unknown } | null;
    const password = body?.password;
    if (typeof password !== 'string' || password === '' || [...password].length > MAX_PASSWORD_LENGTH) return c.json({ error: 'Enter the password.' }, 400);
    const remember = body?.remember === true;
    const address = remote.clientAddress(c) ?? 'unknown';
    const checked = await checkPassword(c, remote, address, password, 401);
    if (checked instanceof Response) return checked;
    const { id, session } = remote.sessions.create({ remember, epoch: checked.epoch, address, userAgent: userAgentOf(c) });
    setSessionCookie(c, id, remember);
    // "Keep me signed in on this device" is also what makes it a remembered device.
    if (remember) setDeviceCookie(c, remote, checked.epoch);
    remote.log(`[grunt-server] signed in from ${address}${remember ? ' (kept signed in for 30 days)' : ''}`);
    return c.json({ expiresAt: session.expiresAt });
  });

  app.post('/logout', (c) => {
    const id = getCookie(c, SESSION_COOKIE, 'host');
    if (id) remote.sessions.end(id);
    clearSessionCookie(c);
    clearDeviceCookie(c);
    return c.body(null, 204);
  });

  app.post('/logout-all', (c) => {
    const bearer = token !== null && tokenMatches(c.req.header('Authorization'), token);
    if (!bearer && !sessionFromCookie(c, remote)) return c.json({ error: SIGN_IN }, 401);
    remote.sessions.endAll();
    // Every remembered device is forgotten too, this one included.
    remote.devices.rotate();
    clearSessionCookie(c);
    clearDeviceCookie(c);
    remote.log(`[grunt-server] every device signed out by ${remote.clientAddress(c) ?? 'unknown'}`);
    return c.body(null, 204);
  });

  app.post('/password', limit, async (c) => {
    if (!isJson(c)) return c.json({ error: 'Send the request as JSON.' }, 415);
    const found = sessionFromCookie(c, remote);
    if (!found) return c.json({ error: SIGN_IN }, 401);
    const body = (await c.req.json().catch(() => null)) as { current?: unknown; next?: unknown } | null;
    const current = body?.current;
    const next = body?.next;
    if (typeof current !== 'string' || typeof next !== 'string' || current === '') return c.json({ error: 'Enter the current and the new password.' }, 400);
    const problem = passwordProblem(next);
    if (problem) return c.json({ error: problem }, 400);
    const address = remote.clientAddress(c) ?? 'unknown';
    // 403, not 401: a 401 tells the web app the session is gone.
    const checked = await checkPassword(c, remote, address, current, 403);
    if (checked instanceof Response) return checked;
    // The session may have ended (signed out everywhere, password changed) while this waited.
    if (!sessionFromCookie(c, remote)) return c.json({ error: SIGN_IN }, 401);
    const record = await remote.passwords.write(next);
    remote.sessions.endAll();
    const { id, session } = remote.sessions.create({ remember: found.session.remember, epoch: record.epoch, address, userAgent: userAgentOf(c) });
    setSessionCookie(c, id, found.session.remember);
    if (found.session.remember) setDeviceCookie(c, remote, record.epoch);
    remote.log(`[grunt-server] password changed from ${address}; every other device is signed out`);
    return c.json({ expiresAt: session.expiresAt });
  });

  return app;
}
