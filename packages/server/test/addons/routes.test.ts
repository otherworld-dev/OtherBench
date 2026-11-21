import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import type { LoadedAddon } from '../../src/addons/loader.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let dataDir: string;
let container: Container;
let page: string;

function loaded(over: Partial<LoadedAddon> = {}): LoadedAddon {
  const routes = new Hono();
  routes.get('/ping', (c) => c.json({ pong: true }));
  return { id: 'glow', name: 'Glow', version: '1.0.0', status: 'loaded', error: null, folder: join(dataDir, 'addons', 'glow'), pagePath: page, routes, module: null, ...over };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'otherbench-addon-routes-'));
  page = join(dataDir, 'addons', 'glow', 'page');
  mkdirSync(page, { recursive: true });
  writeFileSync(join(page, 'index.html'), '<!doctype html><title>Glow</title>');
  writeFileSync(join(page, 'page.js'), 'console.log(1)');
  writeFileSync(join(dataDir, 'addons', 'glow', 'secret.db'), 'SQLite format 3');
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dataDir, 'attachments')),
    events: new AppEventBus(),
    close: () => {},
  };
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const app = (addons: LoadedAddon[], corsOrigins: string[] = []): Hono => {
  container.addons = addons;
  return createApp(container, { corsOrigins });
};

describe('/api/addons', () => {
  it('lists loaded and failed add-ons, and whether each has a settings page', async () => {
    const res = await app([loaded(), loaded({ id: 'bad', name: 'Bad', status: 'failed', error: 'boom', routes: null, pagePath: null })]).request('/api/addons');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { id: 'glow', name: 'Glow', version: '1.0.0', status: 'loaded', error: null, settingsPage: true },
      { id: 'bad', name: 'Bad', version: '1.0.0', status: 'failed', error: 'boom', settingsPage: false },
    ]);
  });

  it("serves an add-on's own routes under its id, and none of a failed one's", async () => {
    const a = app([loaded(), loaded({ id: 'bad', status: 'failed', routes: (() => { const h = new Hono(); h.get('/ping', (c) => c.text('no')); return h; })() })]);
    expect(await (await a.request('/api/addons/glow/ping')).json()).toEqual({ pong: true });
    expect((await a.request('/api/addons/bad/ping')).status).toBe(404);
  });

  it('offers no way to install, change or remove an add-on', async () => {
    const a = app([loaded()]);
    for (const [method, path] of [['POST', '/api/addons'], ['PUT', '/api/addons'], ['DELETE', '/api/addons'], ['PUT', '/api/addons/glow'], ['DELETE', '/api/addons/glow'], ['POST', '/api/addons/glow']] as const) {
      expect((await a.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, `${method} ${path}`).toBe(404);
    }
  });

  it('is an empty list with no add-ons', async () => {
    expect(await (await app([]).request('/api/addons')).json()).toEqual([]);
  });
});

describe('/addons/<id>/ (settings pages)', () => {
  it('serves the page with a policy that lets only OtherBench itself frame it', async () => {
    const res = await app([loaded()], ['tauri://localhost']).request('/addons/glow/index.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/^text\/html/);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("frame-ancestors 'self' tauri://localhost");
    expect(csp).toContain("script-src 'self'");
    expect(res.headers.get('X-Frame-Options')).toBeNull();
    expect((await app([loaded()]).request('/addons/glow/page.js')).headers.get('Content-Type')).toMatch(/^text\/javascript/);
  });

  it('serves the right file when the id in the path is percent-encoded', async () => {
    const res = await app([loaded()]).request('/addons/%67low/page.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
  });

  it('serves index.html for the folder itself', async () => {
    expect((await app([loaded()]).request('/addons/glow/')).status).toBe(200);
  });

  it.each(['/addons/glow/../secret.db', '/addons/glow/%2e%2e/secret.db', '/addons/glow/..%2fsecret.db', '/addons/glow/missing.js', '/addons/nope/index.html'])('404s %s', async (path) => {
    expect((await app([loaded()]).request(path)).status).toBe(404);
  });

  it('404s a file type it does not serve, and a link out of the page folder', async () => {
    writeFileSync(join(page, 'data.db'), 'x');
    const a = app([loaded()]);
    expect((await a.request('/addons/glow/data.db')).status).toBe(404);
    const outside = join(dataDir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'index.html'), '<p>not the page</p>');
    try {
      symlinkSync(outside, join(page, 'out'), 'junction');
    } catch {
      return;
    }
    expect((await a.request('/addons/glow/out/index.html')).status).toBe(404);
  });

  it('serves nothing for an add-on without a settings page, or one that failed', async () => {
    expect((await app([loaded({ pagePath: null })]).request('/addons/glow/index.html')).status).toBe(404);
    expect((await app([loaded({ status: 'failed' })]).request('/addons/glow/index.html')).status).toBe(404);
  });
});
