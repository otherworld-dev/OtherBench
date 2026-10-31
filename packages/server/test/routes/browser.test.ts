import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import type { BrowserFrame, BrowserState } from '@otherbench/tools/browser/manager.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import type { BrowserPort } from '../../src/routes/browser.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const OPEN: BrowserState = { open: true, url: 'https://example.com/', title: 'Example', host: 'example.com', holder: null, visible: true };
const CLOSED: BrowserState = { open: false, url: null, title: null, host: null, holder: null, visible: false };

let container: Container;
let dir: string;
let watcher: { onFrame: (f: BrowserFrame) => void; onState: (s: BrowserState) => void } | null;
let unwatched: boolean;
let browser: { [K in keyof BrowserPort]: ReturnType<typeof vi.fn> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'otherbench-browser-route-'));
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  watcher = null;
  unwatched = false;
  browser = {
    state: vi.fn(() => OPEN),
    close: vi.fn(async () => {}),
    watch: vi.fn((_chatId: string, onFrame: (f: BrowserFrame) => void, onState: (s: BrowserState) => void) => {
      watcher = { onFrame, onState };
      return () => {
        unwatched = true;
      };
    }),
    closeAll: vi.fn(async () => {}),
    input: vi.fn(async () => true),
    show: vi.fn(async () => true),
    forgetProfile: vi.fn(async () => {}),
  };
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dir, 'attachments')),
    streamTimings: { keepaliveMs: 30, idleTimeoutMs: 60_000 },
    browser: browser as unknown as BrowserPort,
    close: () => {},
  };
  store.chats.create({ id: 'c1', title: 'C', profileId: 'p', headMessageId: null, pinned: false, archivedAt: null } as never);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const app = () => createApp(container);
const post = (path: string, body?: unknown) => app().request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('a person using the page', () => {
  it('passes on clicks, scrolling, keys and text', async () => {
    for (const event of [{ type: 'click', x: 0.5, y: 1 }, { type: 'wheel', x: 0, y: 0, dy: -300 }, { type: 'key', key: 'Control+A' }, { type: 'text', text: 'hello' }]) {
      expect((await post('/api/chats/c1/browser/input', event)).status).toBe(204);
      expect(browser.input).toHaveBeenLastCalledWith('c1', event);
    }
  });

  it('refuses anything the panel would not send', async () => {
    for (const event of [{ type: 'click', x: 2, y: 0 }, { type: 'click', x: '0', y: 0 }, { type: 'wheel', x: 0, y: 0, dy: 99999 }, { type: 'key', key: 'a b' }, { type: 'text', text: '' }, { type: 'evaluate' }, null]) {
      expect((await post('/api/chats/c1/browser/input', event)).status).toBe(400);
    }
    expect(browser.input).not.toHaveBeenCalled();
  });

  it('wants JSON, so a cross-site form post cannot reach the page', async () => {
    const res = await app().request('/api/chats/c1/browser/input', { method: 'POST', body: '{"type":"text","text":"x"}' });
    expect(res.status).toBe(415);
    expect(browser.input).not.toHaveBeenCalled();
  });

  it('says so when the chat has no browser open, or it is on another machine', async () => {
    browser.state.mockReturnValue(CLOSED);
    expect((await post('/api/chats/c1/browser/input', { type: 'text', text: 'x' })).status).toBe(409);
    expect((await post('/api/chats/c1/browser/show')).status).toBe(409);
  });

  it('a page that went away mid-click is not an error', async () => {
    browser.input.mockRejectedValue(new Error('Target closed'));
    expect((await post('/api/chats/c1/browser/input', { type: 'click', x: 0, y: 0 })).status).toBe(204);
  });

  it('brings up the window', async () => {
    expect((await post('/api/chats/c1/browser/show')).status).toBe(204);
    expect(browser.show).toHaveBeenCalledWith('c1');
  });

  it('forgets the saved sign-ins', async () => {
    const res = await app().request('/api/browser/profile', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(204);
    expect(browser.forgetProfile).toHaveBeenCalledTimes(1);
  });
});
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  let text = '';
  while (!text.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return text;
}

describe('browser routes', () => {
  it("gives a chat's browser state, 404 for an unknown chat", async () => {
    expect(await json(await app().request('/api/chats/c1/browser'))).toEqual(OPEN);
    expect(browser.state).toHaveBeenCalledWith('c1');
    expect((await app().request('/api/chats/nope/browser')).status).toBe(404);
  });

  it('closes it on a JSON DELETE, and refuses a DELETE that is not JSON', async () => {
    expect((await app().request('/api/chats/c1/browser', { method: 'DELETE' })).status).toBe(415);
    const res = await app().request('/api/chats/c1/browser', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(204);
    expect(browser.close).toHaveBeenCalledWith('c1');
  });

  it('streams a hello, frames at most five a second (newest wins), state changes and keepalives', async () => {
    const res = await app().request('/api/chats/c1/browser/live');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    expect(await readUntil(reader, 'event: hello')).toContain('"open":true');
    watcher!.onFrame({ seq: 1, jpeg: 'AAAA' });
    expect(await readUntil(reader, '"seq":1')).toContain('"type":"frame"');
    watcher!.onFrame({ seq: 2, jpeg: 'BBBB' });
    watcher!.onFrame({ seq: 3, jpeg: 'CCCC' });
    const next = await readUntil(reader, '"seq":3');
    expect(next).not.toContain('"seq":2');
    watcher!.onState(CLOSED);
    expect(await readUntil(reader, '"type":"state"')).toContain('"open":false');
    expect(await readUntil(reader, ': keepalive')).toContain(': keepalive');
    await reader.cancel();
    expect(unwatched).toBe(true);
  });

  it("holds back frames for a client that isn't reading, keeps only the newest, and sends it once the client catches up", async () => {
    const reader = (await app().request('/api/chats/c1/browser/live')).body!.getReader();
    await readUntil(reader, 'event: hello');
    // The client stops reading while 25 frames arrive over 1.25 s (about six send slots).
    for (let seq = 1; seq <= 25; seq++) {
      watcher!.onFrame({ seq, jpeg: `frame-${seq}` });
      await new Promise((r) => setTimeout(r, 50));
    }
    // It reads again: what was queued while it was away is a frame or two, never a backlog.
    let text = '';
    while (!text.includes('"seq":25')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain('"seq":25');
    expect(text.match(/"type":"frame"/g)?.length ?? 0).toBeLessThanOrEqual(2);
    await reader.cancel();
  });

  it('404s a close and a live view of an unknown chat', async () => {
    expect((await app().request('/api/chats/nope/browser', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })).status).toBe(404);
    expect((await app().request('/api/chats/nope/browser/live')).status).toBe(404);
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser.watch).not.toHaveBeenCalled();
  });

  it('says which machine has the browser for a chat that runs elsewhere, and touches nothing here', async () => {
    container.store.peers.create({
      nodeId: 'node-pc',
      name: 'Gigabyte',
      fingerprint: 'f'.repeat(64),
      addresses: [],
      issuedTokenHash: 'h',
      heldTokenRef: 'r',
      platform: 'win32',
      lastSeenAt: null,
      lastSyncSeq: 0,
      pairedAt: 1,
    });
    container.store.chats.create({ id: 'far', title: 'F', profileId: 'p', headMessageId: null, pinned: false, archivedAt: null, runsOn: 'node-pc' } as never);
    expect(await json(await app().request('/api/chats/far/browser'))).toEqual({ open: false, elsewhere: 'Gigabyte' });
    expect((await app().request('/api/chats/far/browser', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })).status).toBe(204);
    expect(browser.close).not.toHaveBeenCalled();
    const reader = (await app().request('/api/chats/far/browser/live')).body!.getReader();
    expect(await readUntil(reader, 'event: hello')).toContain('"elsewhere":"Gigabyte"');
    expect(browser.watch).not.toHaveBeenCalled();
    await reader.cancel();
  });

  it('deleting a chat closes its browser', async () => {
    const res = await app().request('/api/chats/c1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(browser.close).toHaveBeenCalledWith('c1');
  });

  it("doesn't wait for a browser that is slow to close before answering a chat delete", async () => {
    browser.close.mockImplementation(() => new Promise(() => {}));
    const res = await app().request('/api/chats/c1', { method: 'DELETE' });
    expect(res.status).toBe(204);
    browser.close.mockImplementation(async () => {
      throw new Error('boom');
    });
    container.store.chats.create({ id: 'c2', title: 'C2', profileId: 'p', headMessageId: null, pinned: false, archivedAt: null } as never);
    expect((await app().request('/api/chats/c2', { method: 'DELETE' })).status).toBe(204);
  });

  it('is behind the token gate like the rest of /api', async () => {
    const gated = createApp(container, { token: 'secret-token' });
    expect((await gated.request('/api/chats/c1/browser')).status).toBe(401);
    expect((await gated.request('/api/chats/c1/browser/live')).status).toBe(401);
    const ok = await gated.request('/api/chats/c1/browser', { headers: { Authorization: 'Bearer secret-token' } });
    expect(ok.status).toBe(200);
  });
});
