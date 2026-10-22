import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { NextcloudError } from '../../src/nextcloud/client.js';
import { forwardedApi } from '../../src/peer/forward.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { FakeNextcloudClient } from '../nextcloud/fake-client.js';

const made: string[] = [];
function tmp(prefix = 'ob-nextcloud-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

let container: Container;
let store: InMemoryStore;
let secrets: FakeSecretStore;
let fake: FakeNextcloudClient;
let configs: { baseUrl: string; user: string; password: string }[];

function seededFake(): FakeNextcloudClient {
  return new FakeNextcloudClient({
    boards: [
      { id: 5, title: 'OtherBench', labels: [{ id: 1, title: 'Bug', color: 'ff0000' }] },
      { id: 6, title: 'Other', labels: [] },
      { id: 7, title: 'Old', archived: true },
      { id: 8, title: 'Gone', deletedAt: 1700000000 },
    ],
    stacks: [
      { id: 50, boardId: 5, title: 'To Do', order: 0 },
      { id: 51, boardId: 5, title: 'Doing', order: 1 },
      { id: 60, boardId: 6, title: 'To Do', order: 0 },
    ],
    cards: [
      { id: 101, title: '#101 First', stackId: 50, order: 0, description: 'one', labels: [] },
      { id: 202, title: '#202 Elsewhere', stackId: 60, order: 0, description: 'two', labels: [] },
    ],
    collectives: [{ id: 1, name: 'Otherworld Dev' }, { id: 2, name: 'PhD' }],
  });
}

beforeEach(() => {
  store = new InMemoryStore('node-pc');
  secrets = new FakeSecretStore();
  fake = seededFake();
  configs = [];
  const dataDir = tmp('ob-nextcloud-data-');
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store,
    secrets,
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dataDir, 'attachments')),
    nextcloud: (config) => {
      configs.push(config);
      return fake;
    },
    close: () => {},
  };
});

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    createApp(container).request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function setUp(): Promise<void> {
  const res = await send('PUT', '/api/nextcloud', { baseUrl: 'https://nc.example/', user: 'adam', password: 's3cr3t-pw' });
  expect(res.status).toBe(200);
}

describe('Nextcloud settings', () => {
  it('settings round trip never returns the password', async () => {
    const put = await send('PUT', '/api/nextcloud', { baseUrl: 'https://nc.example/', user: ' adam ', password: 's3cr3t-pw' });
    expect(put.status).toBe(200);
    const putBody = await json(put);
    expect(JSON.stringify(putBody)).not.toContain('s3cr3t-pw');

    const get = await send('GET', '/api/nextcloud');
    expect(get.status).toBe(200);
    const body = await json(get);
    expect(body).toEqual({ baseUrl: 'https://nc.example', user: 'adam', passwordSet: true });
    expect(JSON.stringify(body)).not.toContain('s3cr3t-pw');
    expect(await secrets.get('nextcloud:password')).toBe('s3cr3t-pw');
    const stored = store.settings.getValue('nextcloud') as Record<string, unknown>;
    expect(stored).toEqual({ baseUrl: 'https://nc.example', user: 'adam' });
    expect(Object.keys(stored)).not.toContain('password');
    expect(JSON.stringify(stored)).not.toContain('s3cr3t-pw');
  });

  it('starts empty', async () => {
    expect(await json(await send('GET', '/api/nextcloud'))).toEqual({ baseUrl: null, user: null, passwordSet: false });
  });

  it("PUT keeps the password when it's left out and deletes it on null", async () => {
    await setUp();
    const kept = await send('PUT', '/api/nextcloud', { baseUrl: 'https://nc.example/cloud', user: 'adam2' });
    expect(await json(kept)).toEqual({ baseUrl: 'https://nc.example/cloud', user: 'adam2', passwordSet: true });
    expect(await secrets.get('nextcloud:password')).toBe('s3cr3t-pw');

    const changed = await send('PUT', '/api/nextcloud', { baseUrl: 'https://nc2.example', user: 'adam', password: 'other-pw' });
    expect(changed.status).toBe(200);
    expect(await secrets.get('nextcloud:password')).toBe('other-pw');

    const deleted = await send('PUT', '/api/nextcloud', { baseUrl: 'https://nc2.example', user: 'adam', password: null });
    expect(await json(deleted)).toEqual({ baseUrl: 'https://nc2.example', user: 'adam', passwordSet: false });
    expect(await secrets.get('nextcloud:password')).toBeNull();
  });

  it('PUT to another host without a password drops the stored one, so it never goes to the new host', async () => {
    await setUp();
    const moved = await send('PUT', '/api/nextcloud', { baseUrl: 'https://evil.example', user: 'adam' });
    expect(moved.status).toBe(200);
    expect(await json(moved)).toEqual({ baseUrl: 'https://evil.example', user: 'adam', passwordSet: false });
    expect(await secrets.get('nextcloud:password')).toBeNull();
    expect((await send('GET', '/api/nextcloud/boards')).status).toBe(409);
    expect(configs).toEqual([]);
  });

  it('PUT to another host after the URL was cleared drops the kept password too', async () => {
    await setUp();
    await send('PUT', '/api/nextcloud', { baseUrl: '', user: '' });
    expect(await secrets.get('nextcloud:password')).toBe('s3cr3t-pw');
    const res = await send('PUT', '/api/nextcloud', { baseUrl: 'https://evil.example', user: 'adam' });
    expect(await json(res)).toEqual({ baseUrl: 'https://evil.example', user: 'adam', passwordSet: false });
  });

  it('PUT to another host with a new password keeps the new one', async () => {
    await setUp();
    const res = await send('PUT', '/api/nextcloud', { baseUrl: 'https://nc2.example', user: 'adam', password: 'new-pw' });
    expect(await json(res)).toEqual({ baseUrl: 'https://nc2.example', user: 'adam', passwordSet: true });
    expect(await secrets.get('nextcloud:password')).toBe('new-pw');
  });

  it('PUT with a blank URL and user and a null password clears everything', async () => {
    await setUp();
    const res = await send('PUT', '/api/nextcloud', { baseUrl: '', user: '', password: null });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ baseUrl: null, user: null, passwordSet: false });
    expect(store.settings.getValue('nextcloud')).toBeNull();
    expect(await secrets.get('nextcloud:password')).toBeNull();
  });

  it('PUT refuses http on a non-loopback host', async () => {
    const res = await send('PUT', '/api/nextcloud', { baseUrl: 'http://nc.example', user: 'adam', password: 'pw' });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('The Nextcloud URL must start with https://.');
    // Nothing was written.
    expect(store.settings.getValue('nextcloud')).toBeNull();
    expect(await secrets.get('nextcloud:password')).toBeNull();
  });

  it('PUT allows http on a loopback host', async () => {
    const res = await send('PUT', '/api/nextcloud', { baseUrl: 'http://127.0.0.1:8080', user: 'adam', password: 'pw' });
    expect(res.status).toBe(200);
  });

  it('PUT refuses a blank user, a missing URL and an empty password', async () => {
    expect((await send('PUT', '/api/nextcloud', { baseUrl: 'https://nc.example', user: '  ', password: 'pw' })).status).toBe(400);
    expect((await send('PUT', '/api/nextcloud', { user: 'adam', password: 'pw' })).status).toBe(400);
    expect((await send('PUT', '/api/nextcloud', { baseUrl: 'https://nc.example', user: 'adam', password: '' })).status).toBe(400);
    expect(store.settings.getValue('nextcloud')).toBeNull();
  });

  it('PUT never echoes a password embedded in the URL', async () => {
    const res = await send('PUT', '/api/nextcloud', { baseUrl: 'https://adam:s3cr3t-pw@nc.example', user: 'adam' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await json(res))).not.toContain('s3cr3t-pw');
  });

  it('routes need setup', async () => {
    const res = await send('GET', '/api/nextcloud/boards');
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ code: 'nextcloud-not-configured', error: "Nextcloud isn't set up on this machine. Add it in Settings → Nextcloud." });
  });

  it('a URL and user without a password still needs setup', async () => {
    await send('PUT', '/api/nextcloud', { baseUrl: 'https://nc.example', user: 'adam' });
    const res = await send('GET', '/api/nextcloud/boards');
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('nextcloud-not-configured');
  });

  it('hands the client the stored URL, user and password', async () => {
    await setUp();
    await send('GET', '/api/nextcloud/boards');
    expect(configs).toEqual([{ baseUrl: 'https://nc.example', user: 'adam', password: 's3cr3t-pw' }]);
  });
});

describe('POST /api/nextcloud/test', () => {
  it('test reports which apps answer', async () => {
    await setUp();
    fake.apps.bookmarks = false;
    const res = await send('POST', '/api/nextcloud/test');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, message: 'Signed in as Adam.', apps: { deck: true, collectives: true, bookmarks: false } });
  });

  it('test reports a bad login without a 409', async () => {
    await setUp();
    fake.failOn = { call: 'currentUser', error: new NextcloudError('nextcloud-auth', 'Nextcloud rejected the username or app password.') };
    const res = await send('POST', '/api/nextcloud/test');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      ok: false,
      message: 'Nextcloud rejected the username or app password.',
      apps: { deck: false, collectives: false, bookmarks: false },
    });
  });

  it('test before setup is not a 409 either', async () => {
    const res = await send('POST', '/api/nextcloud/test');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: false, apps: { deck: false, collectives: false, bookmarks: false } });
  });
});

describe('boards and collectives', () => {
  it('lists open boards only', async () => {
    await setUp();
    const res = await send('GET', '/api/nextcloud/boards');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([{ id: 5, title: 'OtherBench' }, { id: 6, title: 'Other' }]);
  });

  it('lists collective names', async () => {
    await setUp();
    expect(await json(await send('GET', '/api/nextcloud/collectives'))).toEqual(['Otherworld Dev', 'PhD']);
  });

  it('a Nextcloud failure is a 409 with its code, never a 500', async () => {
    await setUp();
    fake.failOn = { call: 'deckBoards', error: new NextcloudError('nextcloud-unreachable', "Couldn't reach Nextcloud at https://nc.example.") };
    const res = await send('GET', '/api/nextcloud/boards');
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('nextcloud-unreachable');
  });
});

describe('GET /api/nextcloud/detect-links', () => {
  const CLAUDE_MD = '# X\n\n## Project links\n\n- Deck board: `OtherBench`\n- Collectives: `Products/OtherBench` in `Otherworld Dev`\n- Bookmark tag: `otherbench`\n';

  function folderWith(file: string, text: string): string {
    const dir = tmp();
    const path = join(dir, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
    return dir;
  }

  const detect = (path: string) => send('GET', `/api/nextcloud/detect-links?path=${encodeURIComponent(path)}`);

  it('detect-links reads .claude/CLAUDE.md and resolves the board', async () => {
    await setUp();
    const dir = folderWith('.claude/CLAUDE.md', CLAUDE_MD.replace('`OtherBench`', '`otherbench`'));
    writeFileSync(join(dir, 'CLAUDE.md'), '## Project links\n- Deck board: `Other`\n');
    const res = await detect(dir);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      deckBoard: 'otherbench',
      deckBoardId: 5,
      collective: 'Otherworld Dev',
      pagePath: 'Products/OtherBench',
      bookmarkTag: 'otherbench',
    });
  });

  it('falls back to CLAUDE.md at the top of the folder', async () => {
    await setUp();
    const dir = folderWith('CLAUDE.md', '## Project links\n- Deck board: `Other`\n');
    expect(await json(await detect(dir))).toMatchObject({ deckBoard: 'Other', deckBoardId: 6 });
  });

  it('detect-links without Nextcloud set up still parses', async () => {
    const dir = folderWith('.claude/CLAUDE.md', CLAUDE_MD);
    const res = await detect(dir);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ deckBoard: 'OtherBench', deckBoardId: null, bookmarkTag: 'otherbench' });
  });

  it('a failing Nextcloud leaves the board id null, without an error', async () => {
    await setUp();
    fake.failOn = { call: 'deckBoards', error: new NextcloudError('nextcloud-unreachable', 'down') };
    const res = await detect(folderWith('.claude/CLAUDE.md', CLAUDE_MD));
    expect(res.status).toBe(200);
    expect((await json(res)).deckBoardId).toBeNull();
  });

  it('a folder without a CLAUDE.md gives all-null', async () => {
    const res = await detect(tmp());
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ deckBoard: null, collective: null, pagePath: null, bookmarkTag: null, deckBoardId: null });
  });

  it('validates the path as detect-repo does', async () => {
    expect((await send('GET', '/api/nextcloud/detect-links?path=relative/dir')).status).toBe(400);
    expect((await send('GET', '/api/nextcloud/detect-links')).status).toBe(400);
    expect((await detect(join(tmp(), 'missing'))).status).toBe(404);
    const dir = folderWith('file.txt', 'x');
    expect((await detect(join(dir, 'file.txt'))).status).toBe(400);
  });
});

describe('card routes', () => {
  it('card routes', async () => {
    await setUp();

    // GET finds a card on a board other than ?board.
    const got = await send('GET', '/api/nextcloud/cards/202?board=5');
    expect(got.status).toBe(200);
    expect(await json(got)).toMatchObject({ id: 202, title: 'Elsewhere', boardId: 6, boardTitle: 'Other', stackTitle: 'To Do', description: 'two' });

    // PATCH keeps the prefix.
    const patched = await send('PATCH', '/api/nextcloud/cards/101?board=5', { title: 'Renamed', description: 'new', duedate: null });
    expect(patched.status).toBe(200);
    expect(await json(patched)).toMatchObject({ id: 101, title: 'Renamed', description: 'new' });
    expect(fake.card(101).title).toBe('#101 Renamed');

    // move with both ignore knobs is a 409 deck-move-ignored.
    fake.ignoreReorder = true;
    fake.ignoreInternalReorder = true;
    const ignored = await send('POST', '/api/nextcloud/cards/101/move?board=5', { stackId: 51 });
    expect(ignored.status).toBe(409);
    expect((await json(ignored)).code).toBe('deck-move-ignored');
    expect(fake.card(101).stackId).toBe(50);
    fake.ignoreReorder = false;
    fake.ignoreInternalReorder = false;

    const moved = await send('POST', '/api/nextcloud/cards/101/move?board=5', { stackId: 51 });
    expect(moved.status).toBe(204);
    expect(fake.card(101).stackId).toBe(51);

    // DELETE is a 204.
    const deleted = await send('DELETE', '/api/nextcloud/cards/202?board=6');
    expect(deleted.status).toBe(204);
    expect(fake.hasCard(202)).toBe(false);

    // A nextcloud-not-found from the fake is a 404 with that code.
    fake.failOn = { call: 'deckStacks', error: new NextcloudError('nextcloud-not-found', 'Nextcloud answered HTTP 404.') };
    const missing = await send('GET', '/api/nextcloud/cards/101?board=5');
    expect(missing.status).toBe(404);
    expect((await json(missing)).code).toBe('nextcloud-not-found');
    fake.failOn = null;

    // abc as a card id is a 400.
    expect((await send('GET', '/api/nextcloud/cards/abc?board=5')).status).toBe(400);
  });

  it('finds a card by id alone, without ?board', async () => {
    await setUp();
    const res = await send('GET', '/api/nextcloud/cards/202');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: 202, boardId: 6, boardTitle: 'Other' });
    expect((await send('POST', '/api/nextcloud/cards/202/archive')).status).toBe(204);
    expect(fake.card(202).archived).toBe(true);
  });

  it('finds a card when ?board names a board that is gone', async () => {
    await setUp();
    const res = await send('GET', '/api/nextcloud/cards/202?board=99');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: 202, boardId: 6 });
  });

  it('done, reopen, archive and labels answer 204', async () => {
    await setUp();
    expect((await send('POST', '/api/nextcloud/cards/101/labels?board=5', { add: [1] })).status).toBe(204);
    expect(fake.card(101).labels?.map((l) => l.id)).toEqual([1]);
    expect((await send('POST', '/api/nextcloud/cards/101/labels?board=5', { remove: [1] })).status).toBe(204);
    expect(fake.card(101).labels).toEqual([]);
    expect((await send('POST', '/api/nextcloud/cards/101/done?board=5')).status).toBe(204);
    expect(Boolean(fake.card(101).done)).toBe(true);
    expect(fake.card(101).archived).toBe(true);
    expect((await send('POST', '/api/nextcloud/cards/101/reopen?board=5')).status).toBe(204);
    expect(fake.card(101).archived).toBe(false);
    expect((await send('POST', '/api/nextcloud/cards/101/archive?board=5')).status).toBe(204);
    expect(fake.card(101).archived).toBe(true);
  });

  it('refuses bad ids and bodies with a 400', async () => {
    await setUp();
    expect((await send('GET', '/api/nextcloud/cards/101?board=x')).status).toBe(400);
    expect((await send('GET', '/api/nextcloud/cards/101?board=')).status).toBe(400);
    expect((await send('GET', '/api/nextcloud/cards/1234567890?board=5')).status).toBe(400);
    expect((await send('PATCH', '/api/nextcloud/cards/101?board=5', { title: '   ' })).status).toBe(400);
    expect((await send('PATCH', '/api/nextcloud/cards/101?board=5', { duedate: 5 })).status).toBe(400);
    expect((await send('POST', '/api/nextcloud/cards/101/move?board=5', { stackId: 'x' })).status).toBe(400);
    expect((await send('POST', '/api/nextcloud/cards/101/labels?board=5', { add: ['x'] })).status).toBe(400);
    expect(fake.card(101).title).toBe('#101 First');
  });
});

describe('the peer listener', () => {
  it('has no /nextcloud route', async () => {
    await setUp();
    const api = forwardedApi(container);
    for (const path of ['/nextcloud', '/nextcloud/boards', '/nextcloud/collectives', '/nextcloud/cards/101?board=5', '/nextcloud/detect-links?path=/']) {
      const res = await api.request(path, {}, { peerNodeId: 'node-laptop' });
      expect(res.status, path).toBe(404);
    }
    const put = await api.request('/nextcloud', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }, { peerNodeId: 'node-laptop' });
    expect(put.status).toBe(404);
  });
});
