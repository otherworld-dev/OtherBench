import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { from, makeContainer, PASSWORD, remoteFixture, type RemoteFixture } from './helpers.js';

let fx: RemoteFixture;
let ws: string;
let container: Container;

beforeEach(async () => {
  ws = mkdtempSync(join(tmpdir(), 'grunt-remote-view-'));
  container = makeContainer();
  container.store.chats.create({ id: 'c1', title: 'c1', profileId: 'p', headMessageId: null, workspace: { kind: 'machine', nodeId: 'node-self', root: ws }, pinned: false, archivedAt: null } as never);
});
afterEach(() => {
  fx.cleanup();
  rmSync(ws, { recursive: true, force: true });
});

async function signedIn(app: Hono, address: string): Promise<string> {
  const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) }, from(address));
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('/view/ links in sign-in mode', () => {
  it('work only from the address that made them', async () => {
    fx = await remoteFixture();
    const app = createApp(container, { remote: fx.remote });
    writeFileSync(join(ws, 'pic.png'), Buffer.from([0x89, 0x50]));
    const cookie = await signedIn(app, '10.0.0.7');
    const made = await app.request('/api/view/links', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ chatId: 'c1', path: 'pic.png' }) }, from('10.0.0.7'));
    const { url } = (await made.json()) as { url: string };

    expect((await app.request(url, {}, from('10.0.0.7'))).status).toBe(200);
    const elsewhere = await app.request(url, {}, from('10.0.0.99'));
    expect(elsewhere.status).toBe(404);
    expect(await elsewhere.text()).toBe('This link has expired. Open the file again.');
  });

  it('are not bound in open mode', async () => {
    fx = await remoteFixture();
    const app = createApp(container);
    writeFileSync(join(ws, 'pic.png'), Buffer.from([0x89, 0x50]));
    const made = await app.request('/api/view/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: 'c1', path: 'pic.png' }) }, from('127.0.0.1'));
    const { url } = (await made.json()) as { url: string };

    expect((await app.request(url, {}, from('10.0.0.99'))).status).toBe(200);
  });
});

describe('GET /grunt-ca.crt', () => {
  it("serves the CA as DER with --tls auto, and isn't there otherwise", async () => {
    const caDer = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x07]);
    fx = await remoteFixture({ tls: { mode: 'auto', caDer, caFingerprint: 'AA', notAfter: 1, names: ['grunt.test'] } });
    const app = createApp(container, { remote: fx.remote });

    const res = await app.request('/grunt-ca.crt');
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(caDer);
    expect(res.headers.get('Content-Type')).toBe('application/x-x509-ca-cert');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="grunt-ca.crt"');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');

    const other = await remoteFixture();
    try {
      const proxied = createApp(container, { remote: other.remote });
      expect((await proxied.request('/grunt-ca.crt')).status).toBe(404);
    } finally {
      other.cleanup();
    }
  });
});
