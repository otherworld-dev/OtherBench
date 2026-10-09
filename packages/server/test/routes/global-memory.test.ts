import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyGlobalMemoryBody } from '@grunt/core/domain/global-memory.js';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { Profile } from '@grunt/core/types/config.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const NOTE = '## Pinned\n- Windows 11\n\n## Preferences\n- British English\n\n## Setup and tools\n\n## Working style';

let container: Container;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'grunt-global-memory-route-test-'));
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
    close: () => {},
  };
  store.connections.create({ id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
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

describe('GET /api/memory/global', () => {
  it('starts with no About you, the empty note, never saved, and no failure', async () => {
    const res = await send('GET', '/api/memory/global');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      memory: { about: '', aboutUpdatedAt: 0, note: emptyGlobalMemoryBody(), noteUpdatedAt: 0, noteUpdatedBy: 'user', noteSourceChatId: null },
      lastError: null,
    });
  });

  it("reports the summariser's last failure", async () => {
    container.memory = { lastGlobalError: () => ({ message: 'boom', at: 5, chatId: 'c' }) } as never;
    expect((await json(await send('GET', '/api/memory/global'))).lastError).toEqual({ message: 'boom', at: 5, chatId: 'c' });
  });
});

describe('PUT /api/memory/global/about', () => {
  it('saves About you, leaving the note alone', async () => {
    container.store.globalMemory.saveNote(NOTE, 'summariser', 'c', 1);
    const res = await send('PUT', '/api/memory/global/about', { about: 'I am Adam.\nBritish English.' });
    expect(res.status).toBe(200);
    expect((await json<{ memory: Record<string, unknown> }>(res)).memory).toMatchObject({ about: 'I am Adam.\nBritish English.', note: NOTE, noteUpdatedBy: 'summariser' });
  });

  it.each([
    ['a missing about', {}],
    ['a non-string about', { about: 4 }],
    ['4,001 characters', { about: 'x'.repeat(4_001) }],
  ])('refuses %s with 400 and changes nothing', async (_label, body) => {
    const res = await send('PUT', '/api/memory/global/about', body);
    expect(res.status).toBe(400);
    expect(container.store.globalMemory.get().about).toBe('');
  });

  it('accepts exactly 4,000 characters', async () => {
    expect((await send('PUT', '/api/memory/global/about', { about: 'x'.repeat(4_000) })).status).toBe(200);
  });
});

describe('PUT /api/memory/global and its versions', () => {
  it('saves the note as the user, Pinned included, and keeps a version', async () => {
    const res = await send('PUT', '/api/memory/global', { body: NOTE.replace(/\n/g, '\r\n') });
    expect(res.status).toBe(200);
    expect((await json<{ memory: Record<string, unknown> }>(res)).memory).toMatchObject({ note: NOTE, noteUpdatedBy: 'user', noteSourceChatId: null });

    const versions = await json<{ id: string; createdBy: string; length: number }[]>(await send('GET', '/api/memory/global/versions'));
    expect(versions).toEqual([expect.objectContaining({ createdBy: 'user', length: NOTE.length })]);
    expect((await json(await send('GET', `/api/memory/global/versions/${versions[0]!.id}`))).body).toBe(NOTE);
  });

  it("refuses project memory's headings, and an unchanged save adds no version", async () => {
    const bad = await send('PUT', '/api/memory/global', { body: '## Pinned\n\n## Goals\n\n## Decisions\n\n## Current focus\n\n## Open questions' });
    expect(bad.status).toBe(400);
    expect(((await json<{ error: string }>(bad)).error)).toMatch(/## Preferences/);

    await send('PUT', '/api/memory/global', { body: NOTE });
    await send('PUT', '/api/memory/global', { body: NOTE });
    expect(container.store.globalMemory.versions()).toHaveLength(1);
  });

  it('restores an old version as a new user save, and 404s for an unknown one', async () => {
    container.store.globalMemory.saveNote(NOTE, 'summariser', 'c', 1);
    const old = container.store.globalMemory.versions()[0]!;
    container.store.globalMemory.saveNote(NOTE.replace('British', 'American'), 'summariser', 'c', 2);

    const res = await send('POST', `/api/memory/global/versions/${old.id}/restore`);
    expect(res.status).toBe(200);
    expect(container.store.globalMemory.get()).toMatchObject({ note: NOTE, noteUpdatedBy: 'user' });
    expect((await send('POST', '/api/memory/global/versions/nope/restore')).status).toBe(404);
    expect((await send('GET', '/api/memory/global/versions/nope')).status).toBe(404);
  });
});

describe('a profile\'s "Use global memory" switch', () => {
  const base = { name: 'P', connectionId: 'conn-1', modelId: 'm' };

  it('is on by default, can be created off, and PATCHes either way', async () => {
    const on = await json<Profile>(await send('POST', '/api/profiles', base));
    expect(on.useGlobalMemory).toBe(true);
    const off = await json<Profile>(await send('POST', '/api/profiles', { ...base, name: 'Q', useGlobalMemory: false }));
    expect(off.useGlobalMemory).toBe(false);

    const patched = await json<Profile>(await send('PATCH', `/api/profiles/${on.id}`, { useGlobalMemory: false }));
    expect(patched.useGlobalMemory).toBe(false);
  });

  it('refuses a value that is not true or false', async () => {
    expect((await send('POST', '/api/profiles', { ...base, useGlobalMemory: 'yes' })).status).toBe(400);
  });
});
