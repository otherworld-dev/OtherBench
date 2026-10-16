import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { ChatEngine } from '@otherbench/core/ports/chat-engine.js';
import { COMPUTER_DESKTOP_ONLY_REASON } from '@otherbench/core/domain/computer-apps.js';
import { FakeComputerDriver } from '@otherbench/core/testing/fake-computer.js';
import { FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import type { Hono } from 'hono';
import { createApp } from '../../src/app.js';
import { cancelChatReplies, ComputerSessions } from '../../src/computer/sessions.js';
import { createContainer, type Container } from '../../src/container.js';
import { createPeerApp } from '../../src/peer/app.js';
import { forwardedApi } from '../../src/peer/forward.js';
import type { PeerService } from '../../src/peer/service.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { from, PASSWORD, remoteFixture, type RemoteFixture } from '../remote/helpers.js';

// Computer use's routes under remote access (cowork-parity integration, seam
// 5): the thread banner's Stop, GET /api/computer/status, and the session
// events, which go out on the app-wide GET /api/events. Sign-in mode, the
// Host check and the cross-site check all apply to them, and none of them is
// on the peer listener. The desktop is FakeComputerDriver.

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PUBLIC_HOST = 'otherbench.test:4747';
const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const STOP = ['POST', '/api/chats/c1/computer/stop'] as const;
const STATUS = ['GET', '/api/computer/status'] as const;
const EVENTS = ['GET', '/api/events'] as const;
const ROUTES = [STOP, STATUS, EVENTS] as const;

const idle: ChatEngine = {
  async *stream() {},
  listModels: async () => [],
  testConnection: async () => ({ ok: true, message: 'ok', latencyMs: 0 }),
};

let dir: string;
let container: Container;
let driver: FakeComputerDriver;
let events: AppEventBus;
let fx: RemoteFixture;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'otherbench-computer-remote-'));
  const store = new InMemoryStore();
  store.chats.create({ id: 'c1', title: 'Budget', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  const turnRunner = new TurnRunner(store, idle);
  events = new AppEventBus();
  events.attach(turnRunner, store);
  driver = new FakeComputerDriver();
  const computer = new ComputerSessions(driver, {
    emit: (e) => events.emit(e),
    cancelChat: (chatId) => cancelChatReplies(events, turnRunner, chatId),
    chatExists: (chatId) => store.chats.get(chatId) !== null,
  });
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine: idle,
    registry: {} as never,
    toolProvider: { resolveApproval: () => false, answerAsk: () => 'unknown' } as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dir, 'attachments')),
    streamTimings: { keepaliveMs: 30, idleTimeoutMs: 60_000 },
    events,
    computer,
    close: () => {},
  };
  fx = await remoteFixture();
});

afterEach(() => {
  fx.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

/** A chat holding the computer, so a Stop that gets through ends something we can see. */
async function holding(): Promise<void> {
  await container.computer!.ensureSession('c1', 'Budget');
  expect(driver.hasSession('c1')).toBe(true);
}

function call(app: Hono, method: string, path: string, headers: Record<string, string> = {}, address = '10.0.0.7'): Promise<Response> {
  return Promise.resolve(app.request(path, { method, headers: { ...(method === 'POST' ? JSON_HEADERS : {}), ...headers }, ...(method === 'POST' ? { body: '{}' } : {}) }, from(address)));
}

async function signIn(app: Hono, headers: Record<string, string> = {}, address = '10.0.0.7'): Promise<string> {
  const res = await app.request('/api/auth/login', { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify({ password: PASSWORD, remember: false }) }, from(address));
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

/** Reads an SSE answer until `want` shows up in it (or gives up), then lets it go. */
async function readUntil(res: Response, want: string): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 2_000;
  try {
    while (!text.includes(want) && Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 200))]);
      if (value) text += decoder.decode(value);
      if (done && !value && text.includes(want)) break;
    }
  } finally {
    await reader.cancel();
  }
  return text;
}

describe('computer use routes in sign-in mode', () => {
  it('answers Stop, the status and the event stream with 401 to anyone not signed in, and stops nothing', async () => {
    await holding();
    const app = createApp(container, { remote: fx.remote });
    for (const [method, path] of ROUTES) {
      const res = await call(app, method, path);
      expect(res.status, `${method} ${path}`).toBe(401);
      for (const headers of [{ Cookie: '__Host-otherbench_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, { Authorization: 'Bearer guess' }] as Record<string, string>[]) {
        expect((await call(app, method, path, headers)).status, `${method} ${path} ${JSON.stringify(headers)}`).toBe(401);
      }
    }
    expect(driver.hasSession('c1')).toBe(true);
    expect(driver.ended).toEqual([]);
  });

  it('serves them to a signed-in client: the status, the session in the event stream, and Stop (a remote client can turn it off)', async () => {
    await holding();
    const app = createApp(container, { remote: fx.remote });
    const cookie = await signIn(app);
    const same = { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' };
    const status = await call(app, ...STATUS, same);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ computerUse: true });
    const stream = await call(app, ...EVENTS, same);
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(await readUntil(stream, '"chatId":"c1"')).toContain('"computerSessions":[{"chatId":"c1"');
    const stopped = await call(app, ...STOP, { ...same, Origin: PUBLIC_ORIGIN });
    expect(stopped.status).toBe(204);
    expect(driver.ended).toEqual(['c1']);
  });

  it("doesn't take the session cookie from another site's page: no Stop, no status, no events", async () => {
    await holding();
    const app = createApp(container, { remote: fx.remote });
    const cookie = await signIn(app);
    for (const site of ['cross-site', 'same-site']) {
      for (const [method, path] of ROUTES) {
        const res = await call(app, method, path, { Cookie: cookie, 'Sec-Fetch-Site': site });
        // The POST is refused by the cross-site write check before the cookie is looked at (403); the reads by the gate (401).
        expect(res.status, `${site} ${method} ${path}`).toBe(method === 'POST' ? 403 : 401);
      }
    }
    expect(driver.ended).toEqual([]);
  });
});

describe('computer use routes and the cross-site check', () => {
  it("refuses a Stop sent by another site's page, a form or a navigation, in every mode, and stops nothing", async () => {
    await holding();
    const open = createApp(container);
    const signedIn = createApp(container, { remote: fx.remote });
    const cookie = await signIn(signedIn);
    for (const [name, app, auth] of [['open mode', open, {}], ['sign-in mode', signedIn, { Cookie: cookie }]] as const) {
      for (const headers of [
        { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
        { Origin: 'https://evil.example' },
        { Origin: 'null' },
        { 'Sec-Fetch-Site': 'same-site' },
        { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' },
        { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'document' },
      ] as Record<string, string>[]) {
        expect((await call(app, ...STOP, { ...auth, ...headers })).status, `${name} ${JSON.stringify(headers)}`).toBe(403);
      }
    }
    expect(driver.ended).toEqual([]);
    expect((await call(open, ...STOP, { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty' })).status).toBe(204);
    expect(driver.ended).toEqual(['c1']);
  });

  it("gives another site's page no readable status or event stream in open mode: no CORS header on either", async () => {
    const app = createApp(container);
    const status = await call(app, ...STATUS, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    expect(status.headers.get('access-control-allow-origin')).toBeNull();
    const stream = await call(app, ...EVENTS, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    expect(stream.headers.get('access-control-allow-origin')).toBeNull();
    await stream.body?.cancel();
  });
});

describe('computer use routes and the Host check', () => {
  it('answers only on the names the server is reached by: a rebinding Host gets 421 from all three, signed in or not', async () => {
    await holding();
    const app = createApp(container, { remote: fx.remote, hostCheckPort: () => 4747 });
    const cookie = await signIn(app, { Host: PUBLIC_HOST });
    for (const host of ['evil.example:4747', 'evil.example', 'otherbench.test:9999', 'otherbench.test.evil.example:4747']) {
      for (const [method, path] of ROUTES) {
        expect((await call(app, method, path, { Host: host, Cookie: cookie })).status, `${host} ${method} ${path}`).toBe(421);
      }
    }
    expect(driver.ended).toEqual([]);
    for (const host of [PUBLIC_HOST, '127.0.0.1:4747', 'localhost:4747']) {
      expect((await call(app, ...STATUS, { Host: host })).status, host).toBe(401);
      expect((await call(app, ...STATUS, { Host: host, Cookie: cookie })).status, host).toBe(200);
    }
  });

  it('holds in open mode on a loopback bind too', async () => {
    await holding();
    const app = createApp(container, { hostCheckPort: () => 4747 });
    for (const [method, path] of ROUTES) expect((await call(app, method, path, { Host: 'evil.example:4747' })).status, `${method} ${path}`).toBe(421);
    expect(driver.ended).toEqual([]);
    expect((await call(app, ...STATUS, { Host: '127.0.0.1:4747' })).status).toBe(200);
  });
});

describe('computer use routes and the peer listener', () => {
  const peerApp = (paired: boolean): Hono =>
    createPeerApp({ authenticate: () => (paired ? { nodeId: 'node-pc', name: 'Gigabyte' } : null) } as unknown as PeerService, { forwardedApi: () => forwardedApi(container) }) as unknown as Hono;

  it('has none of them: a paired machine gets 404 for Stop, the status and the events, and nothing is stopped', async () => {
    await holding();
    const app = peerApp(true);
    for (const [method, path] of ROUTES) expect((await call(app, method, path)).status, `${method} ${path}`).toBe(404);
    // (`/peer/events` is the listener's own stream of sync and activity hints: see the container test below.)
    for (const path of ['/peer/computer/status', '/peer/chats/c1/computer/stop', '/computer/status', '/events']) {
      expect((await call(app, 'GET', path)).status, path).toBe(404);
      expect((await call(app, 'POST', path)).status, path).toBe(404);
    }
    expect(driver.ended).toEqual([]);
  });

  it('refuses a stranger before any route is looked at', async () => {
    const app = peerApp(false);
    for (const [method, path] of ROUTES) expect((await call(app, method, path)).status, `${method} ${path}`).toBe(401);
  });

  it("never puts a computer session on a paired machine's /peer/events stream: it carries sync and activity hints only", async () => {
    const real = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json'), computer: new FakeComputerDriver() });
    try {
      real.store.connections.create({ id: 'conn', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
      real.store.profiles.create({
        id: 'prof', name: 'P', description: null, colour: null, connectionId: 'conn', modelId: 'mock-standard', systemPrompt: null, params: {},
        toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', computer: true }, isDefault: false, archivedAt: null,
      });
      const chat = real.store.chats.create({ id: 'c9', title: 'Held', profileId: 'prof', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null } as never);
      const sent: string[] = [];
      const unregister = real.peers!.openEventStream('node-pc', (event, data) => sent.push(`${event} ${JSON.stringify(data)}`), () => {});
      const seen: string[] = [];
      real.events!.subscribe((e) => seen.push(e.type));
      await real.computer!.ensureSession(chat.id, 'Held');
      await real.computer!.stop(chat.id);
      unregister();
      // The session started and ended on this machine's own bus, and nothing of it went to the paired machine.
      expect(seen.filter((t) => t === 'computer-session')).toHaveLength(2);
      expect(sent.filter((s) => s.includes('computer'))).toEqual([]);
    } finally {
      real.close();
    }
  });

  it('takes no answer and no change from a paired machine while the computer may be in control here; a Stop still passes', async () => {
    await holding();
    const api = forwardedApi(container);
    for (const path of ['/approvals/req-1/resolve', '/asks/ask-1/answer', '/chats/c1/turns', '/messages/m1/retry']) {
      const res = await api.request(path, { method: 'POST', headers: JSON_HEADERS, body: '{}' }, { peerNodeId: 'node-pc' });
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(COMPUTER_DESKTOP_ONLY_REASON);
    }
    // Whatever Origin it claims: a paired machine is never the desktop app's window.
    const claimed = await api.request('/approvals/req-1/resolve', { method: 'POST', headers: { ...JSON_HEADERS, Origin: 'http://tauri.localhost' }, body: '{}' }, { peerNodeId: 'node-pc' });
    expect(claimed.status).toBe(403);
    // A reply's Stop is not a change it could misuse.
    expect((await api.request('/messages/m1/cancel', { method: 'POST', headers: JSON_HEADERS, body: '{}' }, { peerNodeId: 'node-pc' })).status).not.toBe(403);
  });

  it('the forwarded API itself has no computer route and no event stream', async () => {
    await holding();
    const api = forwardedApi(container);
    for (const [method, path] of [['POST', '/chats/c1/computer/stop'], ['GET', '/computer/status'], ['GET', '/events']] as const) {
      const res = await api.request(path, { method, ...(method === 'POST' ? { headers: JSON_HEADERS, body: '{}' } : {}) }, { peerNodeId: 'node-pc' });
      expect(res.status, path).toBe(404);
    }
    expect(driver.ended).toEqual([]);
  });
});
