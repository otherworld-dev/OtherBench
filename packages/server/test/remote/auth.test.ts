import { rmSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { authGate } from '../../src/remote/auth.js';
import { DEVICE_MS } from '../../src/remote/devices.js';
import { BUDGET_BURST, BUDGET_RESERVED, DEVICE_REFILL_MS, MAX_DELAYED, MAX_TRACKED, SLOW_MAX_MS } from '../../src/remote/limiter.js';
import { PasswordFile } from '../../src/remote/password.js';
import { SESSION_MS } from '../../src/remote/sessions.js';
import { FAST, from, granted, makeContainer, PASSWORD, remoteFixture, type RemoteFixture } from './helpers.js';

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

/** The session's Set-Cookie line (a sign-in also sets the remembered-device cookie). */
const sessionSetCookie = (res: Response): string | undefined => res.headers.getSetCookie().find((c) => c.startsWith('__Host-grunt_session='));
const cookieOf = (res: Response): string => sessionSetCookie(res)!.split(';')[0]!;

/** Fake timers held by waiting sign-in attempts: all of them but the log summary's. */
const attemptTimers = (): number => vi.getTimerCount() - (fx.remote.limiter.stats().summarising ? 1 : 0);

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
    const cookie = sessionSetCookie(res)!;
    expect(cookie).toMatch(/^__Host-grunt_session=[A-Za-z0-9_-]{43}; /);
    for (const part of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) expect(cookie).toContain(part);
    expect(cookie).not.toContain('Max-Age');

    const remembered = sessionSetCookie(await login({ remember: true }))!;
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

describe('the global limits', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** `n` wrong passwords counted straight into the limiter (no budget spent), at most 4 from any one address. */
  function failures(n: number): void {
    for (let i = 0; i < n; i++) fx.remote.limiter.fail(`10.9.${Math.floor(i / 4) % 250}.${(i % 4) + 4 * Math.floor(i / 1000)}`);
    expect(fx.remote.limiter.globalFailures()).toBe(n);
  }

  /** Spends the whole budget on attempts that will wait out a delay. */
  function spendBudget(): void {
    for (let i = 0; i < BUDGET_BURST; i++) void fx.remote.limiter.admit(`10.8.0.${i}`);
  }

  /** Real event-loop turns (setImmediate isn't faked) until `done`, or 5 s of real time: logins run scrypt and file I/O. */
  async function turnsUntil(done: () => boolean): Promise<void> {
    const until = performance.now() + 5000;
    while (!done() && performance.now() < until) await new Promise((r) => setImmediate(r));
  }

  /** Lets a login run up to its timer: until `n` fake timers are pending. */
  async function untilWaiting(n = 1): Promise<void> {
    await turnsUntil(() => attemptTimers() >= n);
    expect(attemptTimers()).toBe(n);
  }

  function settled(p: Promise<Response>): { res: Response | null } {
    const box: { res: Response | null } = { res: null };
    void p.then((res) => {
      box.res = res;
    });
    return box;
  }

  function abortableLogin(signal: AbortSignal, address: string, password = PASSWORD): Promise<Response> {
    const req = new Request('http://localhost/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password, remember: false }), signal });
    return app.request(req, undefined, from(address));
  }

  const rawDeviceCookie = (res: Response): string => {
    const found = res.headers.getSetCookie().find((c) => c.startsWith('__Host-grunt_device='));
    expect(found).toBeDefined();
    return found as string;
  };
  const deviceCookieOf = (res: Response): string => rawDeviceCookie(res).split(';')[0] as string;
  const deviceValid = (cookie: string): boolean => fx.remote.devices.valid(cookie.slice(cookie.indexOf('=') + 1), fx.remote.passwords.epoch());

  it('makes the right password wait out the delay too, then signs in; a wrong one waits and gets 401, never 429', async () => {
    failures(40);
    const pending = settled(login({ address: '10.0.0.50' }));
    await untilWaiting();

    await vi.advanceTimersByTimeAsync(1249);
    expect(pending.res).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await turnsUntil(() => pending.res !== null);
    expect(pending.res?.status).toBe(200);

    const wrong = settled(login({ password: 'not the password', address: '10.0.0.51' }));
    await untilWaiting();
    await vi.advanceTimersByTimeAsync(1250);
    await turnsUntil(() => wrong.res !== null);
    expect(wrong.res?.status).toBe(401);
  });

  it('answers 429 with Retry-After until the next token once the budget is spent', async () => {
    failures(100);
    spendBudget();

    const res = await login({ address: '10.0.0.50' });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('45');
    expect(await res.json()).toEqual({ error: 'Too many sign-in attempts on this server right now. Try again in 45 seconds.' });
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
  });

  it('sets a remembered-device cookie only with "Keep me signed in", and it lets this browser skip the budget and the delay', async () => {
    expect((await login()).headers.getSetCookie().some((c) => c.startsWith('__Host-grunt_device='))).toBe(false);
    const first = await login({ remember: true });
    const device = deviceCookieOf(first);
    for (const part of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=7776000']) expect(rawDeviceCookie(first)).toContain(part);
    failures(5000);
    spendBudget();
    expect((await login({ address: '10.0.0.70' })).status).toBe(429);

    const res = await login({ address: '10.0.0.70', headers: { Cookie: device } });

    expect(res.status).toBe(200);
    // The 18 tokens the two sign-ins left are still waiting out their delay; this one didn't.
    expect(attemptTimers()).toBe(BUDGET_BURST - 2);
    // It is not a session: on its own it opens nothing.
    expect((await get('/api/chats', device)).status).toBe(401);
    // A tampered one is ignored.
    const tampered = device.slice(0, -2) + (device.endsWith('AA') ? 'BB' : 'AA');
    expect((await login({ address: '10.0.0.71', headers: { Cookie: tampered } })).status).toBe(429);
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
  });

  it("locks a remembered device by its own id, not by its address's lock", async () => {
    const device = deviceCookieOf(await login({ remember: true }));
    // Someone else behind the same address guesses it into a lock; the remembered browser still gets in.
    for (let i = 0; i < 5; i++) fx.remote.limiter.fail('10.0.0.7');
    expect((await login()).status).toBe(429);
    expect((await login({ headers: { Cookie: device } })).status).toBe(200);

    // Five wrong passwords with the cookie lock its id for a day; it then counts as no cookie, and the address is locked.
    for (let i = 0; i < 5; i++) {
      fx.clock.now += DEVICE_REFILL_MS;
      expect((await login({ password: 'not the password', address: '10.0.0.81', headers: { Cookie: device } })).status).toBe(401);
    }
    fx.clock.now += DEVICE_REFILL_MS;
    for (let i = 0; i < 5; i++) fx.remote.limiter.fail('10.0.0.7');
    expect((await login({ address: '10.0.0.7', headers: { Cookie: device } })).status).toBe(429);
    expect(fx.remote.limiter.checkDevice(fx.remote.devices.idOf(device.slice(device.indexOf('=') + 1), fx.remote.passwords.epoch())!).ok).toBe(false);
    expect(fx.remote.limiter.check('10.0.0.81')).toEqual({ ok: true });
  });

  it('clears the remembered-device cookie on sign-out', async () => {
    const signedIn = await login({ remember: true });
    const out = await post('/api/auth/logout', `${cookieOf(signedIn)}; ${deviceCookieOf(signedIn)}`);

    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().some((c) => c.startsWith('__Host-grunt_device=;') && c.includes('Max-Age=0'))).toBe(true);
  });

  it('forgets every remembered device on a password change and on "Sign out everywhere"', async () => {
    const signedIn = await login({ remember: true });
    const device = deviceCookieOf(signedIn);
    const other = deviceCookieOf(await login({ remember: true, address: '10.0.0.8' }));
    expect(deviceValid(device)).toBe(true);

    const changed = await post('/api/auth/password', cookieOf(signedIn), { current: PASSWORD, next: 'a brand new password' });
    expect(changed.status).toBe(200);
    expect(deviceValid(device)).toBe(false);
    expect(deviceValid(other)).toBe(false);
    const renewed = deviceCookieOf(changed);
    expect(deviceValid(renewed)).toBe(true);

    const out = await post('/api/auth/logout-all', cookieOf(changed));
    expect(out.status).toBe(204);
    expect(deviceValid(renewed)).toBe(false);
    expect(out.headers.getSetCookie().some((c) => c.startsWith('__Host-grunt_device=;') && c.includes('Max-Age=0'))).toBe(true);
  });

  it("frees a waiting attempt's place and timer when its client disconnects", async () => {
    failures(20);
    const gone = new AbortController();
    const leaving = settled(abortableLogin(gone.signal, '10.0.0.50'));
    await untilWaiting();
    expect(fx.remote.limiter.stats().waiting).toBe(1);

    gone.abort();
    await turnsUntil(() => leaving.res !== null);
    expect(leaving.res?.status).toBe(408);
    expect(fx.remote.limiter.stats()).toMatchObject({ waiting: 0, running: 0 });
    // Walking away after taking a token counts as a failure, so the address is no longer clean.
    expect(fx.remote.limiter.isClean('10.0.0.50')).toBe(false);
    expect(attemptTimers()).toBe(0);
  });

  it('keeps the per-address lockout as it was, and checks it again after the wait', async () => {
    failures(20);
    for (let i = 0; i < 4; i++) fx.remote.limiter.fail('10.0.0.60');
    const pending = settled(login({ address: '10.0.0.60' }));
    await untilWaiting();
    // A fifth wrong password from the same address lands while this one waits.
    fx.remote.limiter.fail('10.0.0.60');

    await vi.advanceTimersByTimeAsync(1250);
    await turnsUntil(() => pending.res !== null);
    expect(pending.res?.status).toBe(429);
    expect(pending.res?.headers.get('retry-after')).toBe('900');
    expect(await pending.res?.json()).toEqual({ error: 'Too many tries. Try again in 15 minutes.' });

    // Locked, it is refused at once without waiting.
    const locked = await login({ address: '10.0.0.60' });
    expect(locked.status).toBe(429);
    expect(attemptTimers()).toBe(0);
  });

  it('slows a password change down too, and refuses it if the session ended while it waited', async () => {
    const cookie = cookieOf(await login());
    failures(40);
    const pending = settled(post('/api/auth/password', cookie, { current: PASSWORD, next: 'a brand new password' }));
    await untilWaiting();
    await vi.advanceTimersByTimeAsync(1249);
    expect(pending.res).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await turnsUntil(() => pending.res !== null);
    expect(pending.res?.status).toBe(200);

    const current = cookieOf(pending.res as Response);
    const second = settled(post('/api/auth/password', current, { current: 'a brand new password', next: 'not going to happen' }));
    await untilWaiting();
    expect((await post('/api/auth/logout', current)).status).toBe(204);
    await vi.advanceTimersByTimeAsync(1250);
    await turnsUntil(() => second.res !== null);
    expect(second.res?.status).toBe(401);
    // The password is still the first change's.
    const record = fx.remote.passwords.read();
    const { verifyPassword } = await import('../../src/remote/password.js');
    expect(await verifyPassword('a brand new password', record!, await granted())).toBe(true);
  });

  it('holds 500 wrong passwords sent at once within every cap, and still lets a remembered device in at once', async () => {
    const device = deviceCookieOf(await login({ remember: true, address: '10.0.0.99' }));
    failures(100);
    const flood = Array.from({ length: 500 }, (_, i) => settled(login({ password: 'not the password', address: `10.50.${Math.floor(i / 250)}.${i % 250}` })));
    const admitted = BUDGET_BURST - 1;
    await turnsUntil(() => flood.filter((f) => f.res !== null).length >= 500 - admitted && attemptTimers() >= admitted);

    const stats = fx.remote.limiter.stats();
    expect(stats.waiting).toBe(admitted);
    expect(stats.waiting).toBeLessThanOrEqual(MAX_DELAYED);
    expect(stats.waitingAddresses).toBeLessThanOrEqual(MAX_DELAYED);
    expect(attemptTimers()).toBe(admitted);
    const refused = flood.filter((f) => f.res !== null).map((f) => f.res as Response);
    expect(refused).toHaveLength(500 - admitted);
    for (const res of refused) {
      expect(res.status).toBe(429);
      const after = Number(res.headers.get('retry-after'));
      expect(after).toBeGreaterThanOrEqual(1);
      expect(after).toBeLessThanOrEqual(55);
    }

    // A remembered device goes straight in; a new one is told when to come back, never locked out.
    expect((await login({ address: '10.0.0.98', headers: { Cookie: device } })).status).toBe(200);
    const stranger = await login({ address: '10.0.0.97' });
    expect(stranger.status).toBe(429);
    expect(Number(stranger.headers.get('retry-after'))).toBeLessThanOrEqual(55);

    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
    await turnsUntil(() => flood.every((f) => f.res !== null));
    expect(flood.filter((f) => f.res?.status === 401)).toHaveLength(admitted);
    expect(fx.remote.limiter.stats()).toMatchObject({ waiting: 0, queued: 0, running: 0 });
    expect(fx.remote.limiter.stats().tracked).toBeLessThanOrEqual(MAX_TRACKED);
  });
});

describe('every way to a password check, and whose address it counts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function turnsUntil(done: () => boolean): Promise<void> {
    const until = performance.now() + 5000;
    while (!done() && performance.now() < until) await new Promise((r) => setImmediate(r));
  }

  const budget = () => fx.remote.limiter.stats().budget;
  const deviceCookieOf = (res: Response): string => res.headers.getSetCookie().find((c) => c.startsWith('__Host-grunt_device='))!.split(';')[0]!;

  /** Spends the 15 tokens any address may take, from addresses that have guessed wrong, leaving the 5 kept for clean ones. */
  function floodFromGuessers(): void {
    for (let i = 0; i < 30; i++) fx.remote.limiter.fail(`10.7.0.${i}`);
    for (let i = 0; i < BUDGET_BURST - BUDGET_RESERVED; i++) {
      void fx.remote.limiter.admit(`10.7.0.${i}`).then((a) => {
        if (a.kind === 'go') a.granted.release('wrong');
      });
    }
    expect(budget()).toBe(BUDGET_RESERVED);
  }

  it('charges the budget for a sign-in and a password change, each a password check', async () => {
    const cookie = cookieOf(await login());
    expect(budget()).toBe(BUDGET_BURST - 1);
    expect((await post('/api/auth/password', cookie, { current: 'not the password', next: 'a brand new password' })).status).toBe(403);
    expect(budget()).toBe(BUDGET_BURST - 2);
  });

  it('refuses a password change from a locked address with 429, before checking anything', async () => {
    const cookie = cookieOf(await login());
    for (let i = 0; i < 5; i++) fx.remote.limiter.fail('10.0.0.7');
    const before = budget();

    const res = await post('/api/auth/password', cookie, { current: PASSWORD, next: 'a brand new password' });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('900');
    expect(budget()).toBe(before);
  });

  it('checks no password for a form body, HEAD, OPTIONS, GET or the sign-out routes', async () => {
    const cookie = cookieOf(await login());
    const before = budget();
    const failures = fx.remote.limiter.globalFailures();
    const form = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie };

    expect((await app.request('/api/auth/login', { method: 'POST', headers: form, body: `password=${encodeURIComponent(PASSWORD)}` }, from('10.0.0.20'))).status).toBe(415);
    expect((await app.request('/api/auth/password', { method: 'POST', headers: form, body: 'current=x&next=y' }, from('10.0.0.20'))).status).toBe(415);
    expect((await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ password: PASSWORD }) }, from('10.0.0.20'))).status).toBe(415);
    for (const method of ['HEAD', 'OPTIONS', 'GET', 'PUT']) {
      for (const path of ['/api/auth/login', '/api/auth/password']) {
        const res = await app.request(path, { method, headers: { ...json, Cookie: cookie } }, from('10.0.0.20'));
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    expect((await post('/api/auth/logout', cookie, { password: PASSWORD })).status).toBe(204);
    expect((await post('/api/auth/logout-all', cookie, { password: PASSWORD })).status).toBe(401);

    expect(budget()).toBe(before);
    expect(fx.remote.limiter.globalFailures()).toBe(failures);
  });

  it("lets a clean address's correct sign-in through a flood from addresses that keep guessing", async () => {
    floodFromGuessers();
    const guesser = await login({ password: 'not the password', address: '10.7.0.29' });
    expect(guesser.status).toBe(429);
    expect(await guesser.json()).toMatchObject({ error: expect.stringMatching(/^Too many sign-in attempts/) });

    const pending = login({ address: '192.168.1.50' });
    await turnsUntil(() => attemptTimers() > BUDGET_BURST - BUDGET_RESERVED);
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
    const res = await pending;
    expect(res.status).toBe(200);
  });

  it('gives a forged or expired remembered-device cookie no priority', async () => {
    const device = deviceCookieOf(await login({ remember: true, address: '10.7.0.29' }));
    floodFromGuessers();
    const forged = device.slice(0, -2) + (device.endsWith('AA') ? 'BB' : 'AA');

    expect((await login({ address: '10.7.0.29', headers: { Cookie: forged } })).status).toBe(429);
    expect((await login({ address: '10.7.0.29', headers: { Cookie: '__Host-grunt_device=made.up.value' } })).status).toBe(429);
    expect((await login({ address: '10.7.0.29', headers: { Cookie: device } })).status).toBe(200);

    // 90 days on the cookie has expired; the same flood again, and it counts for nothing.
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
    fx.clock.now += DEVICE_MS;
    floodFromGuessers();
    expect((await login({ address: '10.7.0.29', headers: { Cookie: device } })).status).toBe(429);
    await vi.advanceTimersByTimeAsync(SLOW_MAX_MS);
  });

  it('ignores X-Forwarded-For without a trusted proxy: the socket address is locked, the named ones are untouched', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await login({ password: 'not the password', headers: { 'X-Forwarded-For': `198.51.100.${i}` } });
      expect(res.status).toBe(401);
    }

    expect((await login({ headers: { 'X-Forwarded-For': '198.51.100.99' } })).status).toBe(429);
    expect(fx.remote.limiter.check('10.0.0.7').ok).toBe(false);
    for (let i = 0; i < 5; i++) {
      expect(fx.remote.limiter.check(`198.51.100.${i}`)).toEqual({ ok: true });
      expect(fx.remote.limiter.isClean(`198.51.100.${i}`)).toBe(true);
    }
  });
});

describe('behind a trusted proxy', () => {
  it('counts only the right-most hop the proxy wrote, whatever the client puts to its left', async () => {
    const proxied = await remoteFixture({ trustProxies: ['10.0.0.1'] });
    try {
      const proxiedApp = createApp(makeContainer(), { remote: proxied.remote });
      const attempt = (password: string, forwarded: string) =>
        proxiedApp.request('/api/auth/login', { method: 'POST', headers: { ...json, 'X-Forwarded-For': forwarded }, body: JSON.stringify({ password }) }, from('10.0.0.1'));

      for (let i = 0; i < 5; i++) expect((await attempt('not the password', `192.0.2.${i}, 203.0.113.5`)).status).toBe(401);

      expect((await attempt(PASSWORD, '192.0.2.200, 203.0.113.5')).status).toBe(429);
      expect(proxied.remote.limiter.check('203.0.113.5').ok).toBe(false);
      expect(proxied.remote.limiter.check('192.0.2.0')).toEqual({ ok: true });
      expect(proxied.remote.limiter.check('10.0.0.1')).toEqual({ ok: true });
      expect((await attempt(PASSWORD, '203.0.113.5, 203.0.113.6')).status).toBe(200);
    } finally {
      proxied.cleanup();
    }
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
