import { rmSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { authGate } from '../../src/remote/auth.js';
import { PasswordFile } from '../../src/remote/password.js';
import { SESSION_MS } from '../../src/remote/sessions.js';
import { FAST, from, makeContainer, PASSWORD, remoteFixture, type RemoteFixture } from './helpers.js';

let fx: RemoteFixture;
let app: Hono;

beforeEach(async () => {
  fx = await remoteFixture();
  app = createApp(makeContainer(), { remote: fx.remote });
});
afterEach(() => fx.cleanup());

const json = { 'Content-Type': 'application/json' };

function login(opts: { password?: string; remember?: boolean; address?: string; headers?: Record<string, string> } = {}) {
  return app.request(
    '/api/auth/login',
    { method: 'POST', headers: { ...json, ...opts.headers }, body: JSON.stringify({ password: opts.password ?? PASSWORD, remember: opts.remember ?? false }) },
    from(opts.address ?? '10.0.0.7')
  );
}

const cookieOf = (res: Response): string => res.headers.get('set-cookie')!.split(';')[0]!;

async function signIn(remember = false, address = '10.0.0.7'): Promise<string> {
  const res = await login({ remember, address });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

const get = (path: string, cookie?: string, headers: Record<string, string> = {}, address = '10.0.0.7') =>
  app.request(path, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }, from(address));

const post = (path: string, cookie: string | null, body?: unknown, address = '10.0.0.7') =>
  app.request(path, { method: 'POST', headers: { ...json, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, from(address));

describe('sign-in mode', () => {
  it('answers the API with 401 "Sign in to Grunt." without a cookie', async () => {
    const res = await get('/api/chats');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Sign in to Grunt.' });
  });

  it('signs in with the password and sets a __Host- cookie, with Max-Age only when remembered', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expiresAt: fx.clock.now + SESSION_MS });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-grunt_session=[A-Za-z0-9_-]{43}; /);
    for (const part of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) expect(cookie).toContain(part);
    expect(cookie).not.toContain('Max-Age');

    const remembered = (await login({ remember: true })).headers.get('set-cookie')!;
    expect(remembered).toContain('Max-Age=2592000');
  });

  it('lets the cookie through only when the browser says the request is same-origin', async () => {
    const cookie = await signIn();

    expect((await get('/api/chats', cookie)).status).toBe(200);
    expect((await get('/api/chats', cookie, { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await get('/api/chats', cookie, { 'Sec-Fetch-Site': 'none' })).status).toBe(200);
    for (const site of ['cross-site', 'same-site']) {
      const res = await get('/api/chats', cookie, { 'Sec-Fetch-Site': site });
      expect(res.status, site).toBe(401);
      // A cross-site page can't sign the user out by sending the cookie the wrong way.
      expect(res.headers.get('set-cookie'), site).toBeNull();
    }
    expect((await get('/api/chats', cookie)).status).toBe(200);
  });

  it('takes the bearer token too when one is set, and refuses a wrong one without trying the cookie', async () => {
    app = createApp(makeContainer(), { remote: fx.remote, token: 'tok' });
    const cookie = await signIn();

    expect((await get('/api/chats', undefined, { Authorization: 'Bearer tok' })).status).toBe(200);
    expect((await get('/api/chats', cookie, { Authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('signs out one device with logout, and every device with logout-all', async () => {
    const a = await signIn();
    const b = await signIn();

    const out = await post('/api/auth/logout', a);
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/^__Host-grunt_session=; Max-Age=0/);
    expect((await get('/api/chats', a)).status).toBe(401);
    expect((await get('/api/chats', b)).status).toBe(200);

    const c = await signIn();
    expect((await post('/api/auth/logout-all', null)).status).toBe(401);
    expect((await post('/api/auth/logout-all', c)).status).toBe(204);
    expect((await get('/api/chats', b)).status).toBe(401);
    expect((await get('/api/chats', c)).status).toBe(401);
  });

  it('changes the password, ending every other session and giving the caller a new one', async () => {
    const mine = await signIn(true);
    const other = await signIn();

    const res = await post('/api/auth/password', mine, { current: PASSWORD, next: 'a brand new password' });
    expect(res.status).toBe(200);
    const fresh = cookieOf(res);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=2592000');

    expect((await get('/api/chats', other)).status).toBe(401);
    expect((await get('/api/chats', mine)).status).toBe(401);
    expect((await get('/api/chats', fresh)).status).toBe(200);
    expect((await login({ password: 'a brand new password' })).status).toBe(200);
    expect((await login({ password: PASSWORD, address: '10.0.0.8' })).status).toBe(401);
  });

  it('refuses a password change with the wrong current password (403, not 401) or a short new one, changing nothing', async () => {
    const mine = await signIn();

    const wrong = await post('/api/auth/password', mine, { current: 'not the password', next: 'a brand new password' });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: 'The current password is wrong.' });
    const short = await post('/api/auth/password', mine, { current: PASSWORD, next: 'short' });
    expect(short.status).toBe(400);
    expect(await short.json()).toEqual({ error: 'The password must be at least 12 characters.' });
    expect((await post('/api/auth/password', null, { current: PASSWORD, next: 'a brand new password' })).status).toBe(401);

    expect((await get('/api/chats', mine)).status).toBe(200);
    expect((await login()).status).toBe(200);
  });

  it('ends a session after 12 hours', async () => {
    const cookie = await signIn();

    fx.clock.now += SESSION_MS;
    const res = await get('/api/chats', cookie);

    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('says "Wrong password." four times, locks on the fifth, then refuses even the right password with 429 and Retry-After', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login({ password: 'not the password' });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Wrong password.' });
    }
    const locked = await login();
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('900');
    expect(await locked.json()).toEqual({ error: 'Too many tries. Try again in 15 minutes.' });

    expect((await login({ address: '10.0.0.8' })).status).toBe(200);
  });

  it('wants JSON for a login (415), and 404s the auth writes outside sign-in mode', async () => {
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ password: PASSWORD }) }, from('10.0.0.7'));
    expect(res.status).toBe(415);

    const open = createApp(makeContainer());
    expect((await open.request('/api/auth/login', { method: 'POST', headers: json, body: '{}' })).status).toBe(404);
  });

  it("refuses a login from another site's page", async () => {
    const res = await login({ headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });

    expect(res.status).toBe(403);
  });

  it('closes an open event stream when its session signs out', async () => {
    const cookie = await signIn();
    const res = await get('/api/events', cookie);
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: hello');

    const next = reader.read();
    await post('/api/auth/logout', cookie);

    expect((await next).done).toBe(true);
  });
});

describe('a stream whose session ends while it is still opening', () => {
  it('is answered 401 and its body cancelled, not left open for a signed-out device', async () => {
    const cookie = await signIn();
    let release!: () => void;
    const opening = new Promise<void>((resolve) => (release = resolve));
    let cancelled = false;
    const slow = new Hono();
    slow.use('*', authGate({ token: null, remote: fx.remote }));
    slow.get('/stream', async () => {
      await opening;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      );
    });

    const pending = slow.request('/stream', { headers: { Cookie: cookie } }, from('10.0.0.7'));
    await post('/api/auth/logout', cookie);
    release();
    const res = await pending;

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Sign in to Grunt.' });
    expect(cancelled).toBe(true);
  });
});

describe('sign-in mode when the password file changes under the server', () => {
  it('ends every session within a second of "grunt password", and open streams at the next sweep', async () => {
    const cookie = await signIn();
    const stream = (await get('/api/events', cookie)).body!.getReader();
    await stream.read();

    await new PasswordFile(fx.loginPath, () => fx.clock.now, FAST).write('changed from the terminal');
    fx.clock.now += 1001;

    // The sweep (once a minute in a real server) closes the open stream...
    const next = stream.read();
    fx.remote.sessions.sweep(fx.remote.passwords.epoch());
    expect((await next).done).toBe(true);
    // ...and any new request with the old cookie is refused.
    expect((await get('/api/chats', cookie)).status).toBe(401);
    expect((await login({ password: 'changed from the terminal' })).status).toBe(200);
  });

  it('lets nobody in once login.json is gone or broken: 503 to a login, and every session ends', async () => {
    const cookie = await signIn();

    rmSync(fx.loginPath);
    fx.clock.now += 1001;
    expect((await get('/api/chats', cookie)).status).toBe(401);
    const res = await login();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'No password is set on this server. Run "grunt password" on it.' });

    writeFileSync(fx.loginPath, 'not json');
    fx.clock.now += 1001;
    expect((await login()).status).toBe(503);
    // None of that counted as a wrong guess.
    expect(fx.remote.limiter.check('10.0.0.7')).toEqual({ ok: true });
  });
});

describe('GET /api/auth/status', () => {
  it('says open in open mode, and token in token mode with signedIn following the bearer', async () => {
    expect(await (await createApp(makeContainer()).request('/api/auth/status')).json()).toEqual({ mode: 'open', signedIn: true });
    const tokenApp = createApp(makeContainer(), { token: 'tok' });
    expect(await (await tokenApp.request('/api/auth/status')).json()).toEqual({ mode: 'token', signedIn: false });
    expect(await (await tokenApp.request('/api/auth/status', { headers: { Authorization: 'Bearer tok' } })).json()).toEqual({ mode: 'token', signedIn: true });
  });

  it('judges a bearer header alone, like the gate: a wrong one with a valid cookie is signed out', async () => {
    app = createApp(makeContainer(), { remote: fx.remote, token: 'tok' });
    const cookie = await signIn();

    const wrong = await get('/api/auth/status', cookie, { Authorization: 'Bearer nope' });
    expect(await wrong.json()).toEqual({ mode: 'login', signedIn: false, caDownload: false });
    expect((await get('/api/chats', cookie, { Authorization: 'Bearer nope' })).status).toBe(401);
    expect(((await (await get('/api/auth/status', undefined, { Authorization: 'Bearer tok' })).json()) as { signedIn: boolean }).signedIn).toBe(true);
  });

  it('in sign-in mode says signed out without a session, and gives the session and remote details with one', async () => {
    expect(await (await get('/api/auth/status')).json()).toEqual({ mode: 'login', signedIn: false, caDownload: false });

    const cookie = await signIn(true);
    expect(await (await get('/api/auth/status', cookie)).json()).toEqual({
      mode: 'login',
      signedIn: true,
      caDownload: false,
      session: { expiresAt: expect.any(Number), remember: true },
      remote: { publicUrls: ['https://grunt.test:4747'], tls: { mode: 'proxy' }, trustProxies: [] },
    });
  });
});
