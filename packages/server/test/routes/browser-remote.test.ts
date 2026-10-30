import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import type { BrowserFrame, BrowserState } from '@otherbench/tools/browser/manager.js';
import type { Hono } from 'hono';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { createPeerApp } from '../../src/peer/app.js';
import { forwardedApi } from '../../src/peer/forward.js';
import type { PeerService } from '../../src/peer/service.js';
import type { BrowserPort } from '../../src/routes/browser.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { from, PASSWORD, remoteFixture, type RemoteFixture } from '../remote/helpers.js';

// The model's browser routes (the state, the live-view SSE stream and the
// DELETE that closes it) under remote access: sign-in mode, the Host check
// and the cross-site check all apply to them, and none of them is on the peer
// listener.

const OPEN: BrowserState = { open: true, url: 'https://example.com/', title: 'Example', host: 'example.com', holder: null };
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PUBLIC_HOST = 'otherbench.test:4747';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const ROUTES = [
  ['GET', '/api/chats/c1/browser'],
  ['GET', '/api/chats/c1/browser/live'],
  ['DELETE', '/api/chats/c1/browser'],
] as const;

let dir: string;
let container: Container;
let browser: { [K in keyof BrowserPort]: ReturnType<typeof vi.fn> };
let fx: RemoteFixture;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'otherbench-browser-remote-'));
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  browser = {
    state: vi.fn(() => OPEN),
    close: vi.fn(async () => {}),
    watch: vi.fn((_chatId: string, _onFrame: (f: BrowserFrame) => void, _onState: (s: BrowserState) => void) => () => {}),
    closeAll: vi.fn(async () => {}),
  };
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: { resolveApproval: () => false, answerAsk: () => 'unknown' } as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dir, 'attachments')),
    streamTimings: { keepaliveMs: 30, idleTimeoutMs: 60_000 },
    browser: browser as unknown as BrowserPort,
    close: () => {},
  };
  store.chats.create({ id: 'c1', title: 'C', profileId: 'p', headMessageId: null, pinned: false, archivedAt: null } as never);
  fx = await remoteFixture();
});

afterEach(() => {
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const untouched = (): void => {
  expect(browser.state).not.toHaveBeenCalled();
  expect(browser.watch).not.toHaveBeenCalled();
  expect(browser.close).not.toHaveBeenCalled();
};

/** One of the three routes, as the web UI sends it (a DELETE is JSON). */
function call(app: Hono, method: string, path: string, headers: Record<string, string> = {}, address = '10.0.0.7'): Promise<Response> {
  return Promise.resolve(app.request(path, { method, headers: { ...(method === 'DELETE' ? JSON_HEADERS : {}), ...headers } }, from(address)));
}

async function signIn(app: Hono, headers: Record<string, string> = {}, address = '10.0.0.7'): Promise<string> {
  const res = await app.request('/api/auth/login', { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify({ password: PASSWORD, remember: false }) }, from(address));
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

/** Ends an SSE answer so its keepalive timer and watcher are let go. */
async function finish(res: Response): Promise<void> {
  await res.body?.cancel();
}

describe("the model's browser routes in sign-in mode", () => {
  it('answers all three with 401 "Sign in to OtherBench." to anyone not signed in, and touches no browser', async () => {
    const app = createApp(container, { remote: fx.remote });
    for (const [method, path] of ROUTES) {
      const res = await call(app, method, path);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(await res.json(), `${method} ${path}`).toEqual({ error: 'Sign in to OtherBench.' });
    }
    // A made-up cookie and a bearer token (none is set in this mode) are no better.
    for (const [method, path] of ROUTES) {
      expect((await call(app, method, path, { Cookie: '__Host-otherbench_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).status, `${method} ${path}`).toBe(401);
      expect((await call(app, method, path, { Authorization: 'Bearer guess' })).status, `${method} ${path}`).toBe(401);
    }
    untouched();
  });

  it('serves the state, the live view and the close to a signed-in browser', async () => {
    const app = createApp(container, { remote: fx.remote });
    const cookie = await signIn(app);
    const state = await call(app, 'GET', '/api/chats/c1/browser', { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' });
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual(OPEN);
    const live = await call(app, 'GET', '/api/chats/c1/browser/live', { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' });
    expect(live.status).toBe(200);
    expect(live.headers.get('content-type')).toContain('text/event-stream');
    expect(browser.watch).toHaveBeenCalledWith('c1', expect.any(Function), expect.any(Function));
    await finish(live);
    const closed = await call(app, 'DELETE', '/api/chats/c1/browser', { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', Origin: PUBLIC_ORIGIN });
    expect(closed.status).toBe(204);
    expect(browser.close).toHaveBeenCalledWith('c1');
  });

  it("doesn't take the session cookie from another site's page: no live view to watch, nothing to close", async () => {
    const app = createApp(container, { remote: fx.remote });
    const cookie = await signIn(app);
    for (const site of ['cross-site', 'same-site']) {
      for (const [method, path] of ROUTES) {
        const res = await call(app, method, path, { Cookie: cookie, 'Sec-Fetch-Site': site });
        // The DELETE is refused by the cross-site write check before the cookie is looked at (403); the reads by the gate (401).
        expect(res.status, `${site} ${method} ${path}`).toBe(method === 'DELETE' ? 403 : 401);
      }
    }
    untouched();
    // The session itself is still good.
    expect((await call(app, 'GET', '/api/chats/c1/browser', { Cookie: cookie })).status).toBe(200);
  });

  it('a session ends with sign-out: the live view and the close are refused afterwards', async () => {
    const app = createApp(container, { remote: fx.remote });
    const cookie = await signIn(app);
    const out = await app.request('/api/auth/logout', { method: 'POST', headers: { ...JSON_HEADERS, Cookie: cookie } }, from('10.0.0.7'));
    expect(out.status).toBeLessThan(300);
    for (const [method, path] of ROUTES) expect((await call(app, method, path, { Cookie: cookie })).status, `${method} ${path}`).toBe(401);
    untouched();
  });
});

describe("the model's browser routes and the cross-site check", () => {
  it("refuses a close sent by another site's page, a form or a navigation, in every mode, and closes nothing", async () => {
    const open = createApp(container);
    const signedIn = createApp(container, { remote: fx.remote });
    const cookie = await signIn(signedIn);
    for (const [name, app, auth] of [['open mode', open, {}], ['sign-in mode', signedIn, { Cookie: cookie }]] as const) {
      for (const headers of [
        { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
        { Origin: 'https://evil.example' },
        { Origin: 'null' },
        { 'Sec-Fetch-Site': 'same-site' },
        // From this origin, but a form or a page load, not OtherBench's own fetch.
        { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' },
        { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'document' },
      ] as Record<string, string>[]) {
        const res = await call(app, 'DELETE', '/api/chats/c1/browser', { ...auth, ...headers });
        expect(res.status, `${name} ${JSON.stringify(headers)}`).toBe(403);
      }
    }
    expect(browser.close).not.toHaveBeenCalled();
    // OtherBench's own window, in both modes.
    expect((await call(open, 'DELETE', '/api/chats/c1/browser', { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty' })).status).toBe(204);
    expect((await call(signedIn, 'DELETE', '/api/chats/c1/browser', { Cookie: cookie, Origin: PUBLIC_ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty' })).status).toBe(204);
    expect(browser.close).toHaveBeenCalledTimes(2);
  });

  it("gives another site's page no live view in open mode either: it can't read the answer, and a preflighted request gets no CORS headers", async () => {
    const app = createApp(container);
    const res = await call(app, 'GET', '/api/chats/c1/browser/live', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    // The stream is a read, so it isn't refused; what keeps the frames from the page is that no origin is ever allowed to read it.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await finish(res);
    const state = await call(app, 'GET', '/api/chats/c1/browser', { Origin: 'https://evil.example' });
    expect(state.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe("the model's browser routes and the Host check", () => {
  it('answers only on the names the server is reached by: a rebinding Host gets 421 from all three, signed in or not', async () => {
    const app = createApp(container, { remote: fx.remote, hostCheckPort: () => 4747 });
    const cookie = await signIn(app, { Host: PUBLIC_HOST });
    for (const host of ['evil.example:4747', 'evil.example', 'otherbench.test:9999', 'otherbench.test.evil.example:4747']) {
      for (const [method, path] of ROUTES) {
        const res = await call(app, method, path, { Host: host, Cookie: cookie });
        expect(res.status, `${host} ${method} ${path}`).toBe(421);
      }
    }
    untouched();
    // The public URL's host and the loopback names are let through to the sign-in gate and the route.
    for (const host of [PUBLIC_HOST, '127.0.0.1:4747', 'localhost:4747']) {
      expect((await call(app, 'GET', '/api/chats/c1/browser', { Host: host })).status, host).toBe(401);
      const live = await call(app, 'GET', '/api/chats/c1/browser/live', { Host: host, Cookie: cookie });
      expect(live.status, host).toBe(200);
      await finish(live);
      expect((await call(app, 'DELETE', '/api/chats/c1/browser', { Host: host, Cookie: cookie })).status, host).toBe(204);
    }
  });

  it('holds in open mode on a loopback bind too', async () => {
    const app = createApp(container, { hostCheckPort: () => 4747 });
    for (const [method, path] of ROUTES) expect((await call(app, method, path, { Host: 'evil.example:4747' })).status, `${method} ${path}`).toBe(421);
    untouched();
    expect((await call(app, 'GET', '/api/chats/c1/browser', { Host: '127.0.0.1:4747' })).status).toBe(200);
  });
});

describe("the model's browser routes and the peer listener", () => {
  /** The peer listener's app, with a paired machine already authenticated (the TLS certificate and token check is the service's). */
  const peerApp = (paired: boolean): Hono =>
    createPeerApp({ authenticate: () => (paired ? { nodeId: 'node-pc', name: 'Gigabyte' } : null), noteCalledFrom: () => {} } as unknown as PeerService, { forwardedApi: () => forwardedApi(container) }) as unknown as Hono;

  it('has none of them: a paired machine gets 404 for the state, the live view and the close, and the browser is never touched', async () => {
    const app = peerApp(true);
    for (const [method, path] of ROUTES) {
      const res = await call(app, method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // Nor under the listener's own prefix.
    for (const path of ['/peer/chats/c1/browser', '/peer/chats/c1/browser/live', '/peer/browser', '/chats/c1/browser/live']) {
      expect((await call(app, 'GET', path)).status, path).toBe(404);
    }
    untouched();
    // The listener does reach the forwarded API for what a paired machine may call: this is the route table's doing, not a dead listener.
    const answered = await app.request('/api/asks/nope/answer', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ declined: true }) });
    expect(answered.status).toBe(404);
    expect(await answered.json()).toEqual({ error: 'Question or plan "nope" is unknown or was already answered.' });
  });

  it('refuses a stranger before any route is looked at', async () => {
    const app = peerApp(false);
    for (const [method, path] of ROUTES) expect((await call(app, method, path)).status, `${method} ${path}`).toBe(401);
    untouched();
  });

  it('the forwarded API itself has no browser route, whatever chat is named', async () => {
    const api = forwardedApi(container);
    for (const path of ['/chats/c1/browser', '/chats/c1/browser/live', '/chats/nope/browser/live']) {
      const res = await api.request(path, {}, { peerNodeId: 'node-pc' });
      expect(res.status, path).toBe(404);
    }
    const closed = await api.request('/chats/c1/browser', { method: 'DELETE', headers: JSON_HEADERS }, { peerNodeId: 'node-pc' });
    expect(closed.status).toBe(404);
    untouched();
  });
});
