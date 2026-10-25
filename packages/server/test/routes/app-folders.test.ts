import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;
let store: InMemoryStore;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ob-app-folders-'));
  store = new InMemoryStore('node-pc');
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

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
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

const NAME_ERROR = '"name" must be 1 to 100 characters.';

describe('app folders', () => {
  it('lists none, then folders in sidebar order', async () => {
    expect(await json(await send('GET', '/api/app-folders'))).toEqual([]);
    store.appFolders.create({ id: 'b', name: 'B', sortOrder: 1 });
    store.appFolders.create({ id: 'a', name: 'A', sortOrder: 0 });
    expect((await json<{ id: string }[]>(await send('GET', '/api/app-folders'))).map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('creates with a trimmed name, defaulting to "New folder", each after the last', async () => {
    const first = await send('POST', '/api/app-folders', { name: '  Work  ' });
    expect(first.status).toBe(201);
    expect(await json(first)).toMatchObject({ name: 'Work', sortOrder: 0 });
    const second = await send('POST', '/api/app-folders', {});
    expect(second.status).toBe(201);
    expect(await json(second)).toMatchObject({ name: 'New folder', sortOrder: 1 });
    expect(store.appFolders.list()).toHaveLength(2);
  });

  it.each([
    ['an empty name', ''],
    ['a blank name', '   '],
    ['a 101-character name', 'x'.repeat(101)],
    ['a non-string name', 5],
  ])('rejects %s on create with 400', async (_label, name) => {
    const res = await send('POST', '/api/app-folders', { name });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toBe(NAME_ERROR);
    expect(store.appFolders.list()).toEqual([]);
  });

  it('accepts a 100-character name', async () => {
    expect((await send('POST', '/api/app-folders', { name: 'x'.repeat(100) })).status).toBe(201);
  });

  it('PATCH renames and reorders; a bad field changes nothing; an unknown id is a 404', async () => {
    store.appFolders.create({ id: 'f1', name: 'Old' });
    const res = await send('PATCH', '/api/app-folders/f1', { name: ' New ', sortOrder: 4 });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ id: 'f1', name: 'New', sortOrder: 4 });
    const only = await send('PATCH', '/api/app-folders/f1', { sortOrder: 2 });
    expect(await json(only)).toMatchObject({ name: 'New', sortOrder: 2 });
    const bad = await send('PATCH', '/api/app-folders/f1', { name: '  ' });
    expect(bad.status).toBe(400);
    expect((await json<{ error: string }>(bad)).error).toBe(NAME_ERROR);
    expect((await send('PATCH', '/api/app-folders/f1', { sortOrder: 1.5 })).status).toBe(400);
    expect(store.appFolders.get('f1')).toMatchObject({ name: 'New', sortOrder: 2 });
    expect((await send('PATCH', '/api/app-folders/nope', { name: 'x' })).status).toBe(404);
  });

  it('DELETE moves its apps out and deletes nothing else; an unknown id is a 404', async () => {
    store.appFolders.create({ id: 'f1', name: 'Work' });
    store.apps.create({ id: 'a1', name: 'a1', folderId: 'f1' });
    store.apps.create({ id: 'a2', name: 'a2' });
    const res = await send('DELETE', '/api/app-folders/f1');
    expect(res.status).toBe(204);
    expect(store.appFolders.get('f1')).toBeNull();
    expect(store.apps.get('a1')?.folderId).toBeNull();
    expect(store.apps.list()).toHaveLength(2);
    expect((await send('DELETE', '/api/app-folders/f1')).status).toBe(404);
  });
});
