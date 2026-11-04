import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@otherbench/store-sqlite/db.js';
import { runMigrations } from '@otherbench/store-sqlite/migrations/index.js';
import { SqliteStore } from '@otherbench/store-sqlite/store.js';
import { createApp } from '../../src/app.js';
import type { SignedInDevice } from '../../src/remote/auth.js';
import { createRemoteAccess, type RemoteAccess } from '../../src/remote/index.js';
import { REMEMBER_MS, SESSION_MS } from '../../src/remote/sessions.js';
import { createPeerApp } from '../../src/peer/app.js';
import { forwardedApi } from '../../src/peer/forward.js';
import type { PeerService } from '../../src/peer/service.js';
import { FAST, from, makeContainer, PASSWORD, remoteFixture, type RemoteFixture } from './helpers.js';

// Sessions kept in the database (migration 037) and Settings → Remote access's
// signed-in devices: GET /api/auth/sessions and DELETE /api/auth/sessions/:id.

const json = { 'Content-Type': 'application/json' };
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let fx: RemoteFixture;
let db: DatabaseSync;
let dbPath: string;
let app: Hono;

function openStore(): SqliteStore {
  db = openDatabase(dbPath);
  runMigrations(db);
  return new SqliteStore(db);
}

beforeEach(async () => {
  // The fixture's folder holds the database too, so cleanup removes both.
  fx = await remoteFixture();
  dbPath = join(fx.dir, 'otherbench.db');
  fx.remote.close();
  fx.remote = remoteOn(openStore());
  app = createApp(makeContainer(), { remote: fx.remote, token: 'tok' });
});
afterEach(() => {
  fx.remote.close();
  try {
    db.close();
  } catch {
    // closed by the test
  }
  fx.cleanup();
});

function remoteOn(store: SqliteStore): RemoteAccess {
  return createRemoteAccess({
    publicUrls: ['https://otherbench.test:4747'],
    trustProxies: [],
    loginPath: fx.loginPath,
    tls: { mode: 'proxy' },
    sessionRepo: store.remoteSessions,
    now: () => fx.clock.now,
    log: () => {},
    scrypt: FAST,
  });
}

const cookieOf = (res: Response): string => res.headers.getSetCookie().find((c) => c.startsWith('__Host-otherbench_session='))!.split(';')[0]!;
const tokenOf = (cookie: string): string => cookie.slice('__Host-otherbench_session='.length);

async function signIn(opts: { remember?: boolean; address?: string; userAgent?: string } = {}): Promise<string> {
  const res = await app.request(
    '/api/auth/login',
    { method: 'POST', headers: { ...json, ...(opts.userAgent ? { 'User-Agent': opts.userAgent } : {}) }, body: JSON.stringify({ password: PASSWORD, remember: opts.remember ?? false }) },
    from(opts.address ?? '10.0.0.7')
  );
  expect(res.status).toBe(200);
  return cookieOf(res);
}

const get = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }, from('10.0.0.7'));
const del = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'DELETE', headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } }, from('10.0.0.7'));

async function devices(cookie?: string, headers: Record<string, string> = {}): Promise<SignedInDevice[]> {
  const res = await get('/api/auth/sessions', cookie, headers);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessions: SignedInDevice[] }).sessions;
}

describe('sessions kept in the database', () => {
  it('survive a restart: a new server on the same database lets the cookie in', async () => {
    const cookie = await signIn({ remember: true });
    expect((await get('/api/chats', cookie)).status).toBe(200);

    // The server stops and starts again.
    fx.remote.close();
    db.close();
    fx.remote = remoteOn(openStore());
    app = createApp(makeContainer(), { remote: fx.remote });

    expect((await get('/api/chats', cookie)).status).toBe(200);
    const status = await (await get('/api/auth/status', cookie)).json();
    expect(status).toMatchObject({ signedIn: true, session: { expiresAt: 1_800_000_000_000 + REMEMBER_MS, remember: true } });
  });

  it('keeps only the token\'s SHA-256: the raw token is nowhere in the database files', async () => {
    const tokens = [await signIn(), await signIn({ remember: true })].map(tokenOf);
    const rows = db.prepare('SELECT * FROM remote_session').all() as Record<string, unknown>[];
    expect(rows.map((r) => r.token_hash).sort()).toEqual(tokens.map((t) => createHash('sha256').update(t).digest('hex')).sort());
    for (const t of tokens) expect(JSON.stringify(rows)).not.toContain(t);

    fx.remote.close();
    db.close();
    for (const file of [dbPath, `${dbPath}-wal`]) {
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file).toString('latin1');
      for (const t of tokens) expect(bytes.includes(t), file).toBe(false);
    }
  });

  it('removes a session past its expiry on lookup, and an expired one on the sweep at start', async () => {
    const lookedUp = await signIn();
    await signIn();
    const kept = await signIn({ remember: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM remote_session').get()).toEqual({ n: 3 });

    fx.clock.now += SESSION_MS;
    expect((await get('/api/chats', lookedUp)).status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) AS n FROM remote_session').get()).toEqual({ n: 2 });

    // A restart sweeps the other expired one before anything asks for it.
    fx.remote.close();
    db.close();
    fx.remote = remoteOn(openStore());
    expect(db.prepare('SELECT COUNT(*) AS n FROM remote_session').get()).toEqual({ n: 1 });
    app = createApp(makeContainer(), { remote: fx.remote });
    expect((await get('/api/chats', kept)).status).toBe(200);
  });

  it('notes last-seen at most once a minute', async () => {
    const cookie = await signIn();
    const seen = (): unknown => (db.prepare('SELECT last_seen_at FROM remote_session').get() as { last_seen_at: number }).last_seen_at;
    const start = fx.clock.now;

    fx.clock.now += 30_000;
    await get('/api/chats', cookie);
    expect(seen()).toBe(start);
    fx.clock.now += 30_000;
    await get('/api/chats', cookie);
    expect(seen()).toBe(start + 60_000);
  });
});

describe('the signed-in devices list', () => {
  it('lists each device newest first with its label, address, times and which one is this one; never a token or its hash', async () => {
    const phone = await signIn({ userAgent: ANDROID_CHROME, address: '192.0.2.10' });
    fx.clock.now += 5_000;
    await signIn({ remember: true, userAgent: IPHONE_SAFARI, address: '192.0.2.11' });

    const res = await get('/api/auth/sessions', phone);
    const body = await res.text();
    const list = (JSON.parse(body) as { sessions: SignedInDevice[] }).sessions;
    expect(list).toEqual([
      { id: expect.any(String), deviceLabel: 'Safari on iPhone', address: '192.0.2.11', createdAt: 1_800_000_005_000, lastSeenAt: 1_800_000_005_000, expiresAt: 1_800_000_005_000 + REMEMBER_MS, remember: true, current: false },
      { id: expect.any(String), deviceLabel: 'Chrome on Android', address: '192.0.2.10', createdAt: 1_800_000_000_000, lastSeenAt: 1_800_000_000_000, expiresAt: 1_800_000_000_000 + SESSION_MS, remember: false, current: true },
    ]);
    const hashes = (db.prepare('SELECT token_hash FROM remote_session').all() as { token_hash: string }[]).map((r) => r.token_hash);
    for (const secret of [tokenOf(phone), ...hashes]) expect(body).not.toContain(secret);
  });

  it('needs a signed-in browser or the bearer token', async () => {
    await signIn();
    expect((await get('/api/auth/sessions')).status).toBe(401);
    expect((await get('/api/auth/sessions', undefined, { Authorization: 'Bearer nope' })).status).toBe(401);
    // The desktop app's token sees them all, none of them its own.
    expect((await devices(undefined, { Authorization: 'Bearer tok' })).map((d) => d.current)).toEqual([false]);
    // A cookie sent cross-site doesn't count.
    expect((await get('/api/auth/sessions', await signIn(), { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(401);
  });

  it('signs out one device: its next request is refused, its open event stream closes, the others stay signed in', async () => {
    const mine = await signIn();
    const other = await signIn();
    const otherId = (await devices(mine)).find((d) => !d.current)!.id;
    const stream = (await get('/api/events', other)).body!.getReader();
    expect(new TextDecoder().decode((await stream.read()).value)).toContain('event: hello');
    const next = stream.read();

    const out = await del(`/api/auth/sessions/${otherId}`, mine);
    expect(out.status).toBe(204);
    // Not this browser's session, so its cookies are left alone.
    expect(out.headers.get('set-cookie')).toBeNull();
    expect((await next).done).toBe(true);
    expect((await get('/api/chats', other)).status).toBe(401);
    expect((await get('/api/chats', mine)).status).toBe(200);
    expect((await devices(mine)).map((d) => d.current)).toEqual([true]);

    const again = await del(`/api/auth/sessions/${otherId}`, mine);
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: 'That device is already signed out.' });
  });

  it("signing this device out from the list clears its cookies, like Sign out", async () => {
    const mine = await signIn({ remember: true });
    const own = (await devices(mine))[0]!.id;

    const out = await del(`/api/auth/sessions/${own}`, mine);
    expect(out.status).toBe(204);
    const cookies = out.headers.getSetCookie();
    expect(cookies.some((c) => /^__Host-otherbench_session=; Max-Age=0/.test(c))).toBe(true);
    expect(cookies.some((c) => /^__Host-otherbench_device=; Max-Age=0/.test(c))).toBe(true);
    expect((await get('/api/chats', mine)).status).toBe(401);
  });

  it('refuses a sign-out without a session, and one sent from another site', async () => {
    const mine = await signIn();
    const id = (await devices(mine))[0]!.id;

    expect((await del(`/api/auth/sessions/${id}`)).status).toBe(401);
    const crossSite = await del(`/api/auth/sessions/${id}`, mine, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' });
    expect(crossSite.status).toBe(403);
    expect((await get('/api/chats', mine)).status).toBe(200);
  });

  it('Sign out everywhere still deletes every row', async () => {
    const mine = await signIn();
    await signIn({ remember: true });
    await signIn();

    const res = await app.request('/api/auth/logout-all', { method: 'POST', headers: { ...json, Cookie: mine } }, from('10.0.0.7'));
    expect(res.status).toBe(204);
    expect(db.prepare('SELECT COUNT(*) AS n FROM remote_session').get()).toEqual({ n: 0 });
  });

  it('is not on the peer listener', async () => {
    const mine = await signIn();
    const id = (await devices(mine))[0]!.id;
    const peer = createPeerApp(
      { authenticate: () => ({ nodeId: 'node-pc', name: 'Gigabyte' }), noteCalledFrom: () => {} } as unknown as PeerService,
      { forwardedApi: () => forwardedApi(makeContainer()) }
    ) as unknown as Hono;
    for (const path of ['/api/auth/sessions', '/peer/auth/sessions', '/auth/sessions']) expect((await peer.request(path)).status, path).toBe(404);
    expect((await peer.request(`/api/auth/sessions/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await get('/api/chats', mine)).status).toBe(200);
  });

  it('answers 404 when sign-in is off', async () => {
    const open = createApp(makeContainer(), {});
    expect((await open.request('/api/auth/sessions')).status).toBe(404);
    expect((await open.request('/api/auth/sessions/x', { method: 'DELETE' })).status).toBe(404);
  });
});
