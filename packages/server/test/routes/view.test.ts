import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { Workspace } from '@grunt/core/types/workspace.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { MAX_VIEW_TEXT_BYTES } from '../../src/routes/view.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { OUTSIDE_MESSAGE } from '../../src/view/roots.js';

let container: Container;
let ws: string;
let outside: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'grunt-view-ws-'));
  outside = mkdtempSync(join(tmpdir(), 'grunt-view-out-'));
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store, secrets: new FakeSecretStore(), engine, registry: {} as never, toolProvider: {} as never, mcpManager: {} as never,
    turnRunner, streamRegistry: new StreamRegistry(turnRunner, store), blobStore: {} as never, close: () => {},
  };
  chat('c1', { kind: 'machine', nodeId: 'node-self', root: ws });
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function chat(id: string, workspace: Workspace | null, extra: Record<string, unknown> = {}): void {
  container.store.chats.create({ id, title: id, profileId: 'p', headMessageId: null, workspace, pinned: false, archivedAt: null, ...extra } as never);
}

const app = () => createApp(container);
const open = (path: string, chatId = 'c1') =>
  app().request('/api/view/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId, path }) });
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('POST /api/view/links', () => {
  it('names the kind, and gives a link only for what the browser loads itself', async () => {
    writeFileSync(join(ws, 'notes.md'), '# Hi');
    writeFileSync(join(ws, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
    writeFileSync(join(ws, 'page.html'), '<p>hi</p>');
    writeFileSync(join(ws, 'main.ts'), 'export {};');
    writeFileSync(join(ws, 'blob.bin'), Buffer.from([1, 0, 2, 0]));

    expect(await json(await open('notes.md'))).toEqual({ path: join(ws, 'notes.md'), name: 'notes.md', kind: 'markdown', url: null, size: 4 });
    const pic = await json(await open(join(ws, 'pic.png')));
    expect(pic).toMatchObject({ kind: 'image', name: 'pic.png' });
    expect(pic['url']).toMatch(/^\/view\/[A-Za-z0-9_-]{22}\/pic\.png$/);
    expect((await json(await open('page.html')))['kind']).toBe('html');
    expect(await json(await open('main.ts'))).toMatchObject({ kind: 'text', url: null });
    expect(await json(await open('blob.bin'))).toMatchObject({ kind: 'other', url: null });
  });

  it("opens files in the chat's extra folders, read-only ones included", async () => {
    writeFileSync(join(outside, 'ref.md'), 'ref');
    chat('c2', { kind: 'machine', nodeId: 'node-self', root: ws }, { folders: [{ workspace: { kind: 'machine', nodeId: 'node-self', root: outside }, access: 'read' }] });
    expect((await json(await open(join(outside, 'ref.md'), 'c2')))['kind']).toBe('markdown');
  });

  it("refuses what isn't in the chat's folders: elsewhere, escaping with .., or through a junction", async () => {
    writeFileSync(join(outside, 'secret.txt'), 'no');
    for (const path of [join(outside, 'secret.txt'), '../' + 'x.txt']) {
      const res = await open(path);
      expect(res.status).toBe(404);
      expect((await json(res))['error']).toBe(OUTSIDE_MESSAGE);
    }
    symlinkSync(outside, join(ws, 'out'), process.platform === 'win32' ? 'junction' : 'dir');
    const through = await open(join(ws, 'out', 'secret.txt'));
    expect(through.status).toBe(404);
    expect((await json(through))['error']).toBe(OUTSIDE_MESSAGE);
  });

  it('says why when the file is missing, a folder, or the chat has no folder here', async () => {
    mkdirSync(join(ws, 'sub'));
    const missing = await open('gone.md');
    expect(missing.status).toBe(404);
    expect((await json(missing))['error']).toBe(`File not found: gone.md`);
    expect((await open('sub')).status).toBe(400);

    container.store.peers.create({ nodeId: 'node-pc', name: 'Gigabyte', fingerprint: 'f'.repeat(64), addresses: [], issuedTokenHash: 'h', heldTokenRef: 'r', platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1 });
    chat('pc', { kind: 'machine', nodeId: 'node-pc', root: 'E:\\Git' });
    expect((await json(await open('a.md', 'pc')))['error']).toBe('This file is on Gigabyte.');
    chat('none', null);
    expect((await json(await open('a.md', 'none')))['error']).toBe('This chat has no workspace folder on this machine.');
    expect((await open('a.md', 'nope')).status).toBe(404);
  });
});

describe('POST /api/view/links, paths Windows reads as another file', () => {
  it('refuses them on every platform, as serving does, so a link never opens to a 404', async () => {
    writeFileSync(join(ws, 'notes.txt'), 'notes');
    // On Windows this writes a hidden stream of notes.txt; elsewhere, a file with a colon in its name.
    writeFileSync(join(ws, 'notes.txt:x.html'), '<p>hidden</p>');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect((await open('notes.txt:x.html')).status).toBe(404);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('POST /api/view/links from another site', () => {
  it('needs a JSON body, so a cross-site form post makes no link', async () => {
    writeFileSync(join(ws, 'a.png'), Buffer.from([0x89]));
    const res = await app().request('/api/view/links', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ chatId: 'c1', path: 'a.png' }) });
    expect(res.status).toBe(415);
  });

  it.runIf(process.platform === 'win32')('refuses Windows paths that name a different file from what they say', async () => {
    writeFileSync(join(ws, 'notes.txt'), 'hi');
    mkdirSync(join(ws, 'sub'));
    writeFileSync(join(ws, 'sub', 'notes.txt'), 'hi');
    // A trailing space at the very end is trimmed as input, so it names the real file; inside the path it doesn't.
    for (const path of ['notes.txt:evil.html', 'notes.txt.', join(ws, 'sub ', 'notes.txt'), join(ws, 'sub.', 'notes.txt'), join(ws, 'notes.txt::$DATA')]) {
      const res = await open(path);
      expect(res.status, path).toBe(404);
    }
  });
});

describe('GET /api/view/text', () => {
  const text = (path: string) => app().request(`/api/view/text?chatId=c1&path=${encodeURIComponent(path)}`);

  it('returns the text, cut at 2 MB, and refuses binary', async () => {
    writeFileSync(join(ws, 'a.md'), '# A');
    expect(await json(await text('a.md'))).toEqual({ path: join(ws, 'a.md'), content: '# A', truncated: false, size: 3 });
    writeFileSync(join(ws, 'big.txt'), 'x'.repeat(MAX_VIEW_TEXT_BYTES + 10));
    const big = await json(await text('big.txt'));
    expect(big['truncated']).toBe(true);
    expect((big['content'] as string).length).toBe(MAX_VIEW_TEXT_BYTES);
    writeFileSync(join(ws, 'b.bin'), Buffer.from([0, 1, 2]));
    const bin = await text('b.bin');
    expect(bin.status).toBe(415);
    expect((await json(bin))['error']).toBe("Can't preview this.");
  });
});

describe('GET /api/view/dirs', () => {
  it("lists the chat's folders, then a folder's entries, folders first", async () => {
    chat('c2', { kind: 'machine', nodeId: 'node-self', root: ws }, { folders: [{ workspace: { kind: 'machine', nodeId: 'node-self', root: outside }, access: 'read' }] });
    const roots = await json(await app().request('/api/view/dirs?chatId=c2'));
    expect(roots['roots']).toEqual([
      { path: ws, label: ws.split(/[\\/]/).pop(), access: 'readwrite', workspace: true },
      { path: outside, label: outside.split(/[\\/]/).pop(), access: 'read', workspace: false },
    ]);

    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'b.md'), '');
    writeFileSync(join(ws, 'a.md'), '');
    const listed = await json(await app().request(`/api/view/dirs?chatId=c1&path=${encodeURIComponent(ws)}`));
    expect(listed['entries']).toEqual([
      { name: 'src', path: join(ws, 'src'), type: 'dir' },
      { name: 'a.md', path: join(ws, 'a.md'), type: 'file' },
      { name: 'b.md', path: join(ws, 'b.md'), type: 'file' },
    ]);
    expect((await app().request(`/api/view/dirs?chatId=c1&path=${encodeURIComponent(outside)}`)).status).toBe(404);
  });

  it('says a file is not a folder when asked to list one', async () => {
    writeFileSync(join(ws, 'a.md'), '');
    const res = await app().request(`/api/view/dirs?chatId=c1&path=${encodeURIComponent(join(ws, 'a.md'))}`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('is a file, not a folder');
  });
});
