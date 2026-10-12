import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import type { BrowserFrame, BrowserState } from '@grunt/tools/browser/manager.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import type { BrowserPort } from '../../src/routes/browser.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const OPEN: BrowserState = { open: true, url: 'https://example.com/', title: 'Example', host: 'example.com', holder: null };
const CLOSED: BrowserState = { open: false, url: null, title: null, host: null, holder: null };

let container: Container;
let dir: string;
let watcher: { onFrame: (f: BrowserFrame) => void; onState: (s: BrowserState) => void } | null;
let unwatched: boolean;
let browser: { [K in keyof BrowserPort]: ReturnType<typeof vi.fn> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grunt-browser-route-'));
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

  it('is behind the token gate like the rest of /api', async () => {
    const gated = createApp(container, { token: 'secret-token' });
    expect((await gated.request('/api/chats/c1/browser')).status).toBe(401);
    expect((await gated.request('/api/chats/c1/browser/live')).status).toBe(401);
    const ok = await gated.request('/api/chats/c1/browser', { headers: { Authorization: 'Bearer secret-token' } });
    expect(ok.status).toBe(200);
  });
});
