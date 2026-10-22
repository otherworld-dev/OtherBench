import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { FakeNextcloudClient } from '../nextcloud/fake-client.js';

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

let container: Container;
let store: InMemoryStore;
let fake: FakeNextcloudClient;

const page = (id: number, title: string, parentId: number, text = '') => ({ id, title, parentId, collectiveId: 1, text });

beforeEach(async () => {
  store = new InMemoryStore('node-pc');
  fake = new FakeNextcloudClient({
    boards: [{ id: 5, title: 'OtherBench', labels: [] }, { id: 6, title: 'Other', labels: [] }],
    stacks: [
      { id: 50, boardId: 5, title: 'To Do', order: 0 },
      { id: 51, boardId: 5, title: 'Doing', order: 1 },
      { id: 60, boardId: 6, title: 'To Do', order: 0 },
    ],
    cards: [{ id: 101, title: '#101 First', stackId: 50, order: 0, description: 'one', labels: [] }],
    collectives: [{ id: 1, name: 'Otherworld Dev' }],
    pages: [
      { ...page(1, 'Landing', 0), fileName: 'Readme.md' },
      page(2, 'Products', 1),
      page(3, 'OtherBench', 2, '# OtherBench'),
      page(4, 'Design', 3, '# Design'),
      page(7, 'Other', 2, '# Other'),
    ],
    bookmarks: [
      { id: 1, url: 'https://a.example', title: 'A', description: '', tags: ['otherbench'], added: 10 },
      { id: 2, url: 'https://b.example', title: 'B', description: '', tags: ['other'], added: 20 },
    ],
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'ob-appnc-'));
  made.push(dataDir);
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
    nextcloud: () => fake,
    close: () => {},
  };
  const res = await send('PUT', '/api/nextcloud', { baseUrl: 'https://nc.example/', user: 'adam', password: 'pw' });
  expect(res.status).toBe(200);
});

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    createApp(container).request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** An app whose folder is on another machine, so nothing here may need it. */
function makeApp(over: Record<string, unknown> = {}): void {
  store.apps.create({ id: 'a1', name: 'A', workspace: { kind: 'machine', nodeId: 'node-laptop', root: '/elsewhere' }, ...over });
}

describe('app deck routes', () => {
  it('GET /deck is 409 no-deck-board without a board', async () => {
    makeApp();
    const res = await send('GET', '/api/apps/a1/deck');
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'no-deck-board', error: "No Deck board set for this app. Add one in the app's settings." });
  });

  it('GET /deck returns the board view', async () => {
    makeApp({ deckBoardId: 5 });
    const res = await send('GET', '/api/apps/a1/deck');
    expect(res.status).toBe(200);
    const body = await json<{ board: { id: number }; stacks: { id: number }[] }>(res);
    expect(body.board.id).toBe(5);
    expect(body.stacks.map((s) => s.id)).toEqual([50, 51]);
  });

  it('POST /deck/cards creates a card on a stack of the board', async () => {
    makeApp({ deckBoardId: 5 });
    const res = await send('POST', '/api/apps/a1/deck/cards', { stackId: 50, title: ' New thing ', description: 'details' });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ title: 'New thing', description: 'details', stackId: 50 });
  });

  it('POST /deck/cards refuses a stack on another board', async () => {
    makeApp({ deckBoardId: 5 });
    const res = await send('POST', '/api/apps/a1/deck/cards', { stackId: 60, title: 'x' });
    expect(res.status).toBe(400);
    expect(fake.data.cards).toHaveLength(1);
  });

  it("works when the app's folder isn't on this machine", async () => {
    makeApp({ deckBoardId: 5, wikiCollective: 'Otherworld Dev', wikiPagePath: 'Products/OtherBench', bookmarkTag: 'otherbench' });
    for (const path of ['/api/apps/a1/deck', '/api/apps/a1/wiki', '/api/apps/a1/links']) {
      expect((await send('GET', path)).status, path).toBe(200);
    }
  });
});

describe('app wiki routes', () => {
  it('GET /wiki is 409 no-wiki-page without a page', async () => {
    makeApp();
    const res = await send('GET', '/api/apps/a1/wiki');
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'no-wiki-page' });
  });

  it('GET /wiki returns the subtree and a page in it', async () => {
    makeApp({ wikiCollective: 'Otherworld Dev', wikiPagePath: 'Products/OtherBench' });
    const tree = await json<{ rootId: number; pages: { id: number }[] }>(await send('GET', '/api/apps/a1/wiki'));
    expect(tree.rootId).toBe(3);
    expect(tree.pages.map((p) => p.id).sort()).toEqual([3, 4]);
    const res = await send('GET', '/api/apps/a1/wiki/pages/4');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: 4, markdown: '# Design' });
  });

  it('GET /wiki with a missing page path is 404 nextcloud-not-found', async () => {
    makeApp({ wikiCollective: 'Otherworld Dev', wikiPagePath: 'Products/Nope' });
    const res = await send('GET', '/api/apps/a1/wiki');
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({ code: 'nextcloud-not-found' });
  });

  it('GET /wiki/pages/:pageId outside the subtree is 404', async () => {
    makeApp({ wikiCollective: 'Otherworld Dev', wikiPagePath: 'Products/OtherBench' });
    const res = await send('GET', '/api/apps/a1/wiki/pages/7');
    expect(res.status).toBe(404);
  });
});

describe('app links routes', () => {
  it('GET /links is 409 no-bookmark-tag without a tag', async () => {
    makeApp();
    const res = await send('GET', '/api/apps/a1/links');
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'no-bookmark-tag' });
  });

  it('links: list, add (tagged), edit, delete', async () => {
    makeApp({ bookmarkTag: 'otherbench' });
    const list = await json<{ tag: string; bookmarks: { id: number }[] }>(await send('GET', '/api/apps/a1/links'));
    expect(list.tag).toBe('otherbench');
    expect(list.bookmarks.map((b) => b.id)).toEqual([1]);

    const add = await send('POST', '/api/apps/a1/links', { url: 'https://c.example', title: 'C', tags: ['extra'] });
    expect(add.status).toBe(201);
    const added = await json<{ id: number; tags: string[] }>(add);
    expect(added.tags).toEqual(['extra', 'otherbench']);

    const edit = await send('PATCH', `/api/apps/a1/links/${added.id}`, { title: 'C2', tags: ['solo'] });
    expect(edit.status).toBe(200);
    expect(await json(edit)).toMatchObject({ title: 'C2', tags: ['solo', 'otherbench'] });

    expect((await send('DELETE', `/api/apps/a1/links/${added.id}`)).status).toBe(204);
    expect(fake.data.bookmarks.some((b) => b.id === added.id)).toBe(false);
  });

  it("editing or deleting a bookmark that isn't this app's is 404", async () => {
    makeApp({ bookmarkTag: 'otherbench' });
    expect((await send('PATCH', '/api/apps/a1/links/2', { title: 'x' })).status).toBe(404);
    expect((await send('DELETE', '/api/apps/a1/links/2')).status).toBe(404);
    expect(fake.data.bookmarks.some((b) => b.id === 2)).toBe(true);
  });

  it('POST /links refuses a javascript: URL', async () => {
    makeApp({ bookmarkTag: 'otherbench' });
    const res = await send('POST', '/api/apps/a1/links', { url: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(fake.data.bookmarks).toHaveLength(2);
  });
});

describe('mounting order', () => {
  it('/apps/detect-repo still answers', async () => {
    const res = await send('GET', `/api/apps/detect-repo?path=${encodeURIComponent(tmpdir())}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toHaveProperty('isRepo');
  });
});
