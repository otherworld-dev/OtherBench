import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountStatic } from '../src/static.js';

describe('mountStatic', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'grunt-web-dist-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a clear placeholder at "/" when the bundle has not been built', async () => {
    const app = new Hono();
    mountStatic(app, { webDistDir: join(dir, 'does-not-exist') });

    const res = await app.request('/');

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Grunt server is running');
    expect(body).toContain('npm run build');
  });

  it('serves the placeholder for any non-API path when the bundle is missing, not just "/"', async () => {
    const app = new Hono();
    mountStatic(app, { webDistDir: join(dir, 'does-not-exist') });

    const res = await app.request('/some/client/route');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Grunt server is running');
  });

  it('never intercepts /api paths, even when the bundle is missing -- an unmatched one still falls through to a plain 404', async () => {
    const app = new Hono();
    app.get('/api/health', (c) => c.json({ status: 'ok' }));
    mountStatic(app, { webDistDir: join(dir, 'does-not-exist') });

    const ok = await app.request('/api/health');
    expect(ok.status).toBe(200);

    const missing = await app.request('/api/nonexistent');
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('Grunt server is running');
  });

  it('serves index.html at "/" once the bundle exists', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Grunt App</title>');

    const app = new Hono();
    mountStatic(app, { webDistDir: dir });

    const res = await app.request('/');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Grunt App');
  });

  it('serves a real built asset with its own content type', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Grunt App</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log("hi");');

    const app = new Hono();
    mountStatic(app, { webDistDir: dir });

    const res = await app.request('/app.js');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toBe('console.log("hi");');
  });

  it('falls back to index.html for an unrecognised client-side route (SPA fallback)', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Grunt App</title>');

    const app = new Hono();
    mountStatic(app, { webDistDir: dir });

    const res = await app.request('/chats/some-id');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Grunt App');
  });

  it('still 404s an unmatched /api path once the bundle exists', async () => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Grunt App</title>');

    const app = new Hono();
    app.get('/api/health', (c) => c.json({ status: 'ok' }));
    mountStatic(app, { webDistDir: dir });

    const res = await app.request('/api/nonexistent');

    expect(res.status).toBe(404);
  });
});
