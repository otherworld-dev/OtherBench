import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Hono } from 'hono';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import { createApp } from '../src/app.js';
import type { Container } from '../src/container.js';
import { announceLine, corsAllowlist, exitOnStdinClose, hostCheck } from '../src/desktop.js';
import { StreamRegistry } from '../src/stream/registry.js';

function makeContainer(): Container {
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  return {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    close: () => {},
  };
}

const APP_ORIGIN = 'http://tauri.localhost';

describe('announceLine', () => {
  it('is a single JSON line carrying the bound port', () => {
    const line = announceLine(51234);

    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual({ port: 51234 });
  });
});

describe('hostCheck', () => {
  function appWithHostCheck(port: number) {
    const app = new Hono();
    app.use('*', hostCheck(() => port));
    app.get('/api/ping', (c) => c.text('pong'));
    return app;
  }

  it.each(['127.0.0.1:4747', 'localhost:4747', 'LOCALHOST:4747', '[::1]:4747'])('lets Host "%s" through', async (host) => {
    const res = await appWithHostCheck(4747).request('/api/ping', { headers: { Host: host } });

    expect(res.status).toBe(200);
  });

  it.each(['evil.example:4747', 'rebound.example', '127.0.0.1:9999', '127.0.0.1'])(
    'rejects Host "%s" with 421 (DNS-rebinding defence)',
    async (host) => {
      const res = await appWithHostCheck(4747).request('/api/ping', { headers: { Host: host } });

      expect(res.status).toBe(421);
      expect(await res.json()).toEqual({ error: expect.stringContaining('Host') });
    }
  );

  it('rejects a request with no Host header at all', async () => {
    const res = await appWithHostCheck(4747).request(new Request('http://x/api/ping'));
    // `new Request` fills nothing in for Host; Hono's `app.request` with a
    // Request object passes it through untouched.
    expect(res.status).toBe(421);
  });

  it('reads the port lazily, so a server started on --port 0 checks against the port it actually bound', async () => {
    let bound = 0;
    const app = new Hono();
    app.use('*', hostCheck(() => bound));
    app.get('/x', (c) => c.text('ok'));

    bound = 50123;
    const res = await app.request('/x', { headers: { Host: '127.0.0.1:50123' } });

    expect(res.status).toBe(200);
  });
});

describe('corsAllowlist', () => {
  function appWithCors(origins: string[]) {
    const app = new Hono();
    app.use('/api/*', corsAllowlist(origins));
    app.get('/api/thing', (c) => c.json({ ok: true }));
    return app;
  }

  it('answers a preflight from an allowed origin, allowing the Authorization header', async () => {
    const res = await appWithCors([APP_ORIGIN]).request('/api/thing', {
      method: 'OPTIONS',
      headers: { Origin: APP_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('authorization');
  });

  it('gives an unlisted origin no CORS headers at all', async () => {
    const res = await appWithCors([APP_ORIGIN]).request('/api/thing', { headers: { Origin: 'https://evil.example' } });

    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('never falls back to a wildcard or to the first listed origin', async () => {
    const res = await appWithCors([APP_ORIGIN, 'tauri://localhost']).request('/api/thing', { headers: { Origin: 'null' } });

    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('exitOnStdinClose', () => {
  it('calls onClose exactly once when stdin ends', async () => {
    const stdin = new PassThrough();
    const onClose = vi.fn();

    exitOnStdinClose(stdin, onClose);
    stdin.end();
    await new Promise((resolve) => setImmediate(resolve));
    stdin.destroy();
    await new Promise((resolve) => setImmediate(resolve));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('createApp desktop options', () => {
  it('answers a CORS preflight before the auth gate, so the browser can learn it may send Authorization', async () => {
    const app = createApp(makeContainer(), { token: 'tok', corsOrigins: [APP_ORIGIN] });

    const res = await app.request('/api/chats', {
      method: 'OPTIONS',
      headers: { Origin: APP_ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
  });

  it('still enforces the token on real requests from the allowed origin', async () => {
    const app = createApp(makeContainer(), { token: 'tok', corsOrigins: [APP_ORIGIN] });

    const without = await app.request('/api/chats', { headers: { Origin: APP_ORIGIN } });
    const withToken = await app.request('/api/chats', { headers: { Origin: APP_ORIGIN, Authorization: 'Bearer tok' } });

    expect(without.status).toBe(401);
    expect(withToken.status).toBe(200);
    expect(withToken.headers.get('Access-Control-Allow-Origin')).toBe(APP_ORIGIN);
  });

  it('applies the Host check ahead of everything, health included', async () => {
    const app = createApp(makeContainer(), { hostCheckPort: () => 4747 });

    const bad = await app.request('/api/health', { headers: { Host: 'evil.example:4747' } });
    const good = await app.request('/api/health', { headers: { Host: '127.0.0.1:4747' } });

    expect(bad.status).toBe(421);
    expect(good.status).toBe(200);
  });

  it('adds no CORS or Host checking when neither option is given (browser mode unchanged)', async () => {
    const app = createApp(makeContainer());

    const res = await app.request('/api/chats', { headers: { Origin: APP_ORIGIN, Host: 'anything.example' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('cross-site writes to the API (Deck #897)', () => {
  // The classic attack: a form with enctype text/plain whose body reads as JSON.
  const post = (app: Hono, headers: Record<string, string>) =>
    app.request('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Host: '127.0.0.1:4747', ...headers },
      body: JSON.stringify({ name: 'Evil', kind: 'mock' }),
    });

  it("refuses a write sent from another site's page, so a hidden form can't create a connection in browser mode", async () => {
    const container = makeContainer();
    const app = createApp(container);
    for (const headers of [
      { Origin: 'https://evil.example' },
      { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { Origin: 'http://127.0.0.1:4748' },
    ]) {
      const res = await post(app, headers);
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json(), JSON.stringify(headers)).toMatchObject({ error: expect.stringMatching(/another site/) });
    }
    expect(container.store.connections.list()).toEqual([]);
  });

  it('lets through the UI Grunt serves, the Vite dev proxy, the desktop webview, and clients that are no browser', async () => {
    const app = createApp(makeContainer(), { corsOrigins: [APP_ORIGIN] });
    for (const headers of [
      { Origin: 'http://127.0.0.1:4747', 'Sec-Fetch-Site': 'same-origin' },
      { Origin: 'http://127.0.0.1:4747' },
      { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin' },
      { Origin: APP_ORIGIN, 'Sec-Fetch-Site': 'cross-site' },
      {},
    ]) {
      expect((await post(app, headers)).status, JSON.stringify(headers)).toBe(201);
    }
  });

  it("refuses a form sent from a page Grunt shows, even from its own origin: a PDF isn't sandboxed and could submit one", async () => {
    const container = makeContainer();
    const app = createApp(container);
    for (const headers of [
      { Origin: 'http://127.0.0.1:4747', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate' },
      { Origin: 'http://127.0.0.1:4747', Referer: 'http://127.0.0.1:4747/view/abc/doc.pdf' },
      { Referer: 'http://127.0.0.1:4747/view/abc/doc.pdf' },
    ]) {
      expect((await post(app, headers)).status, JSON.stringify(headers)).toBe(403);
    }
    expect(container.store.connections.list()).toEqual([]);
    // The UI's own fetches still go through.
    expect((await post(app, { Origin: 'http://127.0.0.1:4747', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', Referer: 'http://127.0.0.1:4747/' })).status).toBe(201);
  });

  it('leaves reads alone: CORS already keeps another site from reading the answer', async () => {
    const res = await createApp(makeContainer()).request('/api/chats', { headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
    expect(res.status).toBe(200);
  });
});
