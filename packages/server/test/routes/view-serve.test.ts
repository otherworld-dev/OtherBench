import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { parseRange, relativeOf, viewServeRoutes } from '../../src/routes/view-serve.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { VIEW_LINK_TTL_MS, ViewLinks } from '../../src/view/links.js';

let container: Container;
let ws: string;
let outside: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'grunt-serve-ws-'));
  outside = mkdtempSync(join(tmpdir(), 'grunt-serve-out-'));
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store, secrets: new FakeSecretStore(), engine, registry: {} as never, toolProvider: {} as never, mcpManager: {} as never,
    turnRunner, streamRegistry: new StreamRegistry(turnRunner, store), blobStore: {} as never, close: () => {},
  };
  store.chats.create({ id: 'c1', title: 'c1', profileId: 'p', headMessageId: null, workspace: { kind: 'machine', nodeId: 'node-self', root: ws }, pinned: false, archivedAt: null } as never);
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function linkFor(app: ReturnType<typeof createApp>, path: string): Promise<string> {
  const res = await app.request('/api/view/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: 'c1', path }) });
  return ((await res.json()) as { url: string }).url;
}

describe('GET /view/<id>/', () => {
  it('serves an HTML page and its own folder in the sandbox, and nothing outside that folder', async () => {
    mkdirSync(join(ws, 'site'));
    writeFileSync(join(ws, 'site', 'index.html'), '<p>hi</p>');
    writeFileSync(join(ws, 'site', 'style.css'), 'p{}');
    writeFileSync(join(ws, 'site', 'tool.exe'), 'MZ');
    writeFileSync(join(ws, 'secret.txt'), 'no');
    const app = createApp(container);
    const url = await linkFor(app, 'site/index.html');
    const id = url.split('/')[2]!;

    const page = await app.request(`http://127.0.0.1:4747${url}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<p>hi</p>');
    expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(page.headers.get('Content-Security-Policy')).toBe(
      `sandbox allow-scripts allow-forms; default-src https: data: blob: 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:4747/view/${id}/; connect-src https: wss:; form-action https:`
    );

    const css = await app.request(`/view/${id}/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    expect((await app.request(`/view/${id}/tool.exe`)).status).toBe(415);
    for (const escape of [`/view/${id}/..%2Fsecret.txt`, `/view/${id}/%2E%2E/secret.txt`, `/view/${id}/sub%5C..%5C..%5Csecret.txt`]) {
      expect((await app.request(escape)).status).toBe(404);
    }
  });

  it('serves a single file only under its own name, with names that need encoding', async () => {
    writeFileSync(join(ws, 'café #1.png'), Buffer.from([0x89, 0x50]));
    writeFileSync(join(ws, 'other.png'), Buffer.from([0x89]));
    const app = createApp(container);
    const url = await linkFor(app, 'café #1.png');
    const res = await app.request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Security-Policy')).toMatch(/^sandbox allow-scripts allow-forms;/);
    const id = url.split('/')[2]!;
    expect((await app.request(`/view/${id}/other.png`)).status).toBe(404);
  });

  it('serves ranges for video, and refuses one it cannot satisfy', async () => {
    writeFileSync(join(ws, 'clip.mp4'), Buffer.from(Array.from({ length: 100 }, (_, i) => i)));
    const app = createApp(container);
    const url = await linkFor(app, 'clip.mp4');
    const part = await app.request(url, { headers: { Range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 10-19/100');
    expect(Array.from(new Uint8Array(await part.arrayBuffer()))).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const whole = await app.request(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('Accept-Ranges')).toBe('bytes');
    expect((await app.request(url, { headers: { Range: 'bytes=200-' } })).status).toBe(416);
  });

  it('serves a PDF without the sandbox, which would stop it showing', async () => {
    writeFileSync(join(ws, 'doc.pdf'), '%PDF-1.4');
    const app = createApp(container);
    const res = await app.request(await linkFor(app, 'doc.pdf'));
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('refuses a file swapped for a junction to outside after the link was made', async () => {
    mkdirSync(join(ws, 'site'));
    writeFileSync(join(ws, 'site', 'index.html'), 'mine');
    writeFileSync(join(outside, 'index.html'), 'theirs');
    const app = createApp(container);
    const url = await linkFor(app, 'site/index.html');
    renameSync(join(ws, 'site'), join(ws, 'site-old'));
    symlinkSync(outside, join(ws, 'site'), process.platform === 'win32' ? 'junction' : 'dir');
    const res = await app.request(url);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('theirs');
  });

  it("stops serving a link once its folder is no longer the chat's, or the chat is gone", async () => {
    writeFileSync(join(outside, 'ref.png'), Buffer.from([0x89]));
    writeFileSync(join(ws, 'a.png'), Buffer.from([0x89]));
    container.store.chats.update('c1', { folders: [{ workspace: { kind: 'machine', nodeId: 'node-self', root: outside }, access: 'read' }] });
    const app = createApp(container);
    const ref = await linkFor(app, join(outside, 'ref.png'));
    const own = await linkFor(app, 'a.png');
    expect((await app.request(ref)).status).toBe(200);
    container.store.chats.update('c1', { folders: [] });
    expect((await app.request(ref)).status).toBe(404);
    expect((await app.request(own)).status).toBe(200);
    container.store.chats.delete('c1');
    expect((await app.request(own)).status).toBe(404);
  });

  it('says a link has expired after 10 minutes', async () => {
    writeFileSync(join(ws, 'a.png'), Buffer.from([0x89]));
    let now = 0;
    const links = new ViewLinks(() => now);
    const id = links.create({ chatId: 'c1', root: ws, target: join(ws, 'a.png'), scope: 'file' });
    const serve = viewServeRoutes(links);
    expect((await serve.request(`/${id}/a.png`)).status).toBe(200);
    now += VIEW_LINK_TTL_MS;
    const gone = await serve.request(`/${id}/a.png`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toBe('This link has expired. Open the file again.');
  });

  it('is served ahead of the web app when the server also serves the UI', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'grunt-serve-dist-'));
    writeFileSync(join(dist, 'index.html'), '<html>app</html>');
    writeFileSync(join(ws, 'a.png'), Buffer.from([0x89]));
    const app = createApp(container, { webDistDir: dist });
    const res = await app.request(await linkFor(app, 'a.png'));
    expect(res.headers.get('Content-Type')).toBe('image/png');
    rmSync(dist, { recursive: true, force: true });
  });

  it('serves each artifact version as its own kind: a note made into a page', async () => {
    const store = container.store;
    store.messages.create({ id: 'u1', chatId: 'c1', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    store.artifacts.create({ id: 'bear', chatId: 'c1', slug: 'bear', kind: 'markdown', language: null, createdAt: 1 });
    store.artifacts.addVersion({ id: 'b1', artifactId: 'bear', title: 'Bear', content: '# Bear', madeBy: 'model', messageId: 'u1', parentVersionId: null, createdAt: 2 });
    store.artifacts.addVersion({ id: 'b2', artifactId: 'bear', title: 'Bear', content: '<p>bear</p>', kind: 'html', language: null, madeBy: 'model', messageId: 'u1', parentVersionId: 'b1', createdAt: 3 });
    const app = createApp(container);
    const open = async (artifactVersionId: string) =>
      (await (await app.request('/api/view/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: 'c1', artifactVersionId }) })).json()) as { name: string; kind: string; url: string | null };
    expect(await open('b1')).toMatchObject({ name: 'bear.md', kind: 'markdown', url: null });
    const page = await open('b2');
    expect(page).toMatchObject({ name: 'bear.html', kind: 'html' });
    const served = await app.request(page.url!);
    expect(served.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await served.text()).toBe('<p>bear</p>');
  });

  // Reads Grunt's 5 MB mermaid.min.js, which can take seconds the first time while the whole suite runs.
  it('serves artifact versions: a page and an SVG in the sandbox, a Mermaid diagram with its script, nothing else', async () => {
    const store = container.store;
    store.messages.create({ id: 'u1', chatId: 'c1', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    const make = (id: string, slug: string, kind: 'html' | 'svg' | 'mermaid' | 'markdown', content: string) => {
      store.artifacts.create({ id, chatId: 'c1', slug, kind, language: null, createdAt: 1 });
      return store.artifacts.addVersion({ id: `${id}-v1`, artifactId: id, title: slug, content, madeBy: 'model', messageId: 'u1', parentVersionId: null, createdAt: 2 }).id;
    };
    const app = createApp(container);
    const open = async (artifactVersionId: string) =>
      (await (await app.request('/api/view/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: 'c1', artifactVersionId }) })).json()) as { name: string; kind: string; url: string | null };

    const page = await open(make('p', 'calc', 'html', '<p>calc</p>'));
    expect(page).toMatchObject({ name: 'calc.html', kind: 'html' });
    const served = await app.request(page.url!);
    expect(await served.text()).toBe('<p>calc</p>');
    expect(served.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(served.headers.get('Content-Security-Policy')).toMatch(/^sandbox allow-scripts allow-forms;.*form-action https:$/);

    const svg = await open(make('s', 'logo', 'svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(svg).toMatchObject({ name: 'logo.svg', kind: 'image' });
    expect((await app.request(svg.url!)).headers.get('Content-Type')).toBe('image/svg+xml');

    const diagram = await open(make('m', 'flow', 'mermaid', 'graph TD; A-->B'));
    expect(diagram).toMatchObject({ name: 'diagram.html', kind: 'html' });
    expect(await (await app.request(diagram.url!)).text()).toContain('graph TD; A--&gt;B');
    const id = diagram.url!.split('/')[2]!;
    const script = await app.request(`/view/${id}/mermaid.min.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect((await app.request(`/view/${id}/other.js`)).status).toBe(404);

    expect(await open(make('d', 'notes', 'markdown', '# n'))).toMatchObject({ name: 'notes.md', kind: 'markdown', url: null });
    // A version from another chat isn't this chat's to open.
    store.chats.create({ id: 'c2', title: 'C2', profileId: 'p', headMessageId: null, workspace: null, pinned: false, archivedAt: null } as never);
    const other = await app.request('/api/view/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: 'c2', artifactVersionId: 'p-v1' }) });
    expect(other.status).toBe(404);
    // The link dies with its chat.
    store.chats.delete('c1');
    expect((await app.request(page.url!)).status).toBe(404);
  }, 20_000);
});

describe('relativeOf and parseRange', () => {
  it('decodes segment by segment, refusing encoded separators, dot segments and NUL', () => {
    expect(relativeOf('/view/abc/a%20b/c.png', 'abc')).toBe('a b/c.png');
    // Windows reads `a.txt:x.js` as a hidden stream of a.txt and drops a trailing dot or space: a different file from the name's.
    for (const bad of ['/view/abc/', '/view/abc/..', '/view/abc/a%2Fb', '/view/abc/a%5Cb', '/view/abc/a%00', '/view/abc/%E0%A4%A', '/view/xyz/a', '/view/abc/a.txt:x.js', '/view/abc/a.html.', '/view/abc/a.html%20', '/view/abc/sub./a.png']) {
      expect(relativeOf(bad, 'abc')).toBeNull();
    }
  });

  it('reads one byte range, and says when it cannot be satisfied', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
    expect(parseRange('bytes=8-100', 10)).toEqual({ start: 8, end: 9 });
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    for (const bad of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-']) expect(parseRange(bad, 10)).toBe('bad');
  });
});
