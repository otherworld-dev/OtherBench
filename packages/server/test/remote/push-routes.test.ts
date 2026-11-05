import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSecretStore } from '@otherbench/core/testing/fakes.js';
import { openDatabase } from '@otherbench/store-sqlite/db.js';
import { runMigrations } from '@otherbench/store-sqlite/migrations/index.js';
import { SqliteStore } from '@otherbench/store-sqlite/store.js';
import { createApp } from '../../src/app.js';
import type { SignedInDevice } from '../../src/remote/auth.js';
import { createRemoteAccess } from '../../src/remote/index.js';
import { SESSION_MS } from '../../src/remote/sessions.js';
import type { PushRequest } from '../../src/push/endpoint.js';
import { PushService } from '../../src/push/service.js';
import type { PushStatusBody } from '../../src/routes/push.js';
import { fakeBrowser } from '../push/helpers.js';
import { FAST, from, makeContainer, PASSWORD, remoteFixture, type RemoteFixture } from './helpers.js';

// Web Push routes in sign-in mode (`/api/push`): a device's subscription is its
// remote session's, so signing it out removes it; private endpoints are refused.

const json = { 'Content-Type': 'application/json' };
let fx: RemoteFixture;
let db: DatabaseSync;
let store: SqliteStore;
let app: Hono;
let push: PushService;
let sent: PushRequest[];

beforeEach(async () => {
  fx = await remoteFixture();
  fx.remote.close();
  db = openDatabase(join(fx.dir, 'otherbench.db'));
  runMigrations(db);
  store = new SqliteStore(db);
  fx.remote = createRemoteAccess({
    publicUrls: ['https://otherbench.test:4747'],
    trustProxies: [],
    loginPath: fx.loginPath,
    tls: { mode: 'proxy' },
    sessionRepo: store.remoteSessions,
    now: () => fx.clock.now,
    log: () => {},
    scrypt: FAST,
  });
  sent = [];
  push = new PushService({
    store,
    secrets: new FakeSecretStore(),
    subject: 'https://otherbench.test:4747',
    now: () => fx.clock.now,
    log: () => {},
    transport: async (req) => {
      sent.push(req);
      return { status: 201 };
    },
  });
  app = createApp({ ...makeContainer(), store }, { remote: fx.remote, token: 'tok', push });
});
afterEach(() => {
  fx.remote.close();
  db.close();
  fx.cleanup();
});

const cookieOf = (res: Response): string => res.headers.getSetCookie().find((c) => c.startsWith('__Host-otherbench_session='))!.split(';')[0]!;

async function signIn(): Promise<string> {
  const res = await app.request('/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password: PASSWORD }) }, from('10.0.0.7'));
  expect(res.status).toBe(200);
  return cookieOf(res);
}

const call = (method: string, path: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(
    path,
    { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? json : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    from('10.0.0.7')
  );

async function subscribe(cookie: string, endpoint = 'https://fcm.googleapis.com/fcm/send/abc') {
  const b = fakeBrowser();
  return call('PUT', '/api/push/subscription', cookie, { endpoint, keys: { p256dh: b.p256dh, auth: b.auth }, prefs: { replies: false } });
}

const rows = (): number => (db.prepare('SELECT COUNT(*) AS n FROM push_subscription').get() as { n: number }).n;

describe('/api/push in sign-in mode', () => {
  it("gives a signed-in browser the key to subscribe with, and saves and reads back its own subscription", async () => {
    const cookie = await signIn();
    const before = (await (await call('GET', '/api/push', cookie)).json()) as PushStatusBody;
    expect(before).toMatchObject({ available: true, subscribed: false, prefs: null });
    expect(Buffer.from(before.publicKey!, 'base64url')).toHaveLength(65);

    const res = await subscribe(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: true, prefs: { approvals: true, replies: false, scheduled: true } });
    expect(await (await call('GET', '/api/push', cookie)).json()).toMatchObject({ available: true, subscribed: true, prefs: { approvals: true, replies: false, scheduled: true } });

    // Another device sees only its own state.
    const other = await signIn();
    expect(await (await call('GET', '/api/push', other)).json()).toMatchObject({ subscribed: false });

    expect((await call('PATCH', '/api/push/subscription', cookie, { prefs: { replies: true } })).status).toBe(200);
    expect(store.pushSubscriptions.list()[0]!.prefs.replies).toBe(true);
    expect((await call('POST', '/api/push/test', cookie)).status).toBe(200);
    expect(sent).toHaveLength(1);

    expect((await call('DELETE', '/api/push/subscription', cookie)).status).toBe(204);
    expect(rows()).toBe(0);
  });

  it('refuses https endpoints on this machine or a private network, and plain http', async () => {
    const cookie = await signIn();
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://localhost:4747/api/chats',
      'https://127.0.0.1/push',
      'https://[::1]/push',
      'https://10.0.0.1/push',
      'https://192.168.1.20/push',
      'https://169.254.169.254/latest/meta-data',
      'https://nas.local/push',
      'https://router/push',
    ]) {
      const res = await subscribe(cookie, endpoint);
      expect(res.status, endpoint).toBe(400);
    }
    expect(rows()).toBe(0);
  });

  it("removes a device's subscription when that device is signed out from the list, signs out, or expires", async () => {
    const phone = await signIn();
    const laptop = await signIn();
    expect((await subscribe(phone, 'https://fcm.googleapis.com/fcm/send/phone')).status).toBe(200);
    expect((await subscribe(laptop, 'https://fcm.googleapis.com/fcm/send/laptop')).status).toBe(200);
    expect(rows()).toBe(2);

    // Signed out from the laptop's devices list.
    const list = ((await (await call('GET', '/api/auth/sessions', laptop)).json()) as { sessions: SignedInDevice[] }).sessions;
    const phoneId = list.find((d) => !d.current)!.id;
    expect((await call('DELETE', `/api/auth/sessions/${phoneId}`, laptop)).status).toBe(204);
    expect(store.pushSubscriptions.list().map((s) => s.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/laptop']);
    expect((await call('GET', '/api/push', phone)).status).toBe(401);

    // Nothing goes to the signed-out phone.
    await push.handle({ type: 'approval-requested', chatId: 'c', messageId: 'm', requestId: 'r', toolName: 't' });
    expect(sent.map((r) => r.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/laptop']);

    // Sign out on the device itself.
    expect((await call('POST', '/api/auth/logout', laptop)).status).toBe(204);
    expect(rows()).toBe(0);

    // A session that expires takes its subscription with it.
    const tablet = await signIn();
    expect((await subscribe(tablet, 'https://fcm.googleapis.com/fcm/send/tablet')).status).toBe(200);
    fx.clock.now += SESSION_MS;
    fx.remote.sessions.sweep();
    expect(rows()).toBe(0);
  });

  it('Sign out everywhere removes every subscription', async () => {
    const a = await signIn();
    const b = await signIn();
    await subscribe(a, 'https://fcm.googleapis.com/fcm/send/a');
    await subscribe(b, 'https://fcm.googleapis.com/fcm/send/b');
    expect((await call('POST', '/api/auth/logout-all', a)).status).toBe(204);
    expect(rows()).toBe(0);
  });

  it('has no device for the bearer token, and nothing without sign-in', async () => {
    expect(await (await call('GET', '/api/push', undefined, undefined, { Authorization: 'Bearer tok' })).json()).toMatchObject({ available: false });
    expect((await call('PUT', '/api/push/subscription', undefined, { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'x', auth: 'y' } }, { Authorization: 'Bearer tok' })).status).toBe(409);
    expect((await call('GET', '/api/push')).status).toBe(401);
    expect((await call('PUT', '/api/push/subscription', undefined, {})).status).toBe(401);
  });

  it('says a device showing OtherBench is active, so it gets no push meanwhile', async () => {
    const cookie = await signIn();
    await subscribe(cookie);
    expect((await call('POST', '/api/push/active', cookie, { visible: true })).status).toBe(204);
    await push.handle({ type: 'approval-requested', chatId: 'c', messageId: 'm', requestId: 'r1', toolName: 't' });
    expect(sent).toHaveLength(0);
    expect((await call('POST', '/api/push/active', cookie, { visible: false })).status).toBe(204);
    await push.handle({ type: 'approval-requested', chatId: 'c', messageId: 'm', requestId: 'r2', toolName: 't' });
    expect(sent).toHaveLength(1);
    expect((await call('POST', '/api/push/active', cookie, { visible: 'yes' })).status).toBe(400);
  });
});

describe('/api/push outside sign-in mode', () => {
  it('says push is not available and refuses writes', async () => {
    const open = createApp(makeContainer());
    expect(await (await open.request('/api/push')).json()).toMatchObject({ available: false, subscribed: false });
    const res = await open.request('/api/push/subscription', { method: 'PUT', headers: json, body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } }) });
    expect(res.status).toBe(404);
  });
});
