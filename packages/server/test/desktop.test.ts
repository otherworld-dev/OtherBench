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
