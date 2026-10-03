import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { Profile } from '@grunt/core/types/config.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;
let dataDir: string;

function makeProfile(over: Partial<Profile> & { id: string }): Profile {
  return {
    name: over.id,
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'model-1',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    ...over,
  };
}

// Same container shape as projects.test.ts: DELETE /api/profiles/:id runs the real blob sweep.
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'grunt-settings-route-test-'));
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
  store.profiles.create(makeProfile({ id: 'profile-cheap', name: 'Local Llama' }));
  store.profiles.create(makeProfile({ id: 'profile-big', name: 'Opus' }));
  store.profiles.create(makeProfile({ id: 'profile-old', name: 'Old', archivedAt: 1 }));
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

describe('/api/settings', () => {
  it('GET returns the defaults: no memory model', async () => {
    const res = await send('GET', '/api/settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memoryProfileId: null });
  });

  it('PATCH sets the memory model and null clears it', async () => {
    const set = await send('PATCH', '/api/settings', { memoryProfileId: 'profile-cheap' });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ memoryProfileId: 'profile-cheap' });
    expect(await (await send('GET', '/api/settings')).json()).toEqual({ memoryProfileId: 'profile-cheap' });

    expect(await (await send('PATCH', '/api/settings', { memoryProfileId: null })).json()).toEqual({ memoryProfileId: null });
    expect(await (await send('PATCH', '/api/settings', {})).json()).toEqual({ memoryProfileId: null });
  });

  it('PATCH rejects an unknown, archived, empty or non-string profile id and keeps the stored one', async () => {
    container.store.settings.update({ memoryProfileId: 'profile-big' });
    const cases: [unknown, string][] = [
      ['no-such-profile', '"memoryProfileId": profile "no-such-profile" not found.'],
      ['profile-old', '"memoryProfileId": profile "Old" is archived.'],
      ['', '"memoryProfileId": profile "" not found.'],
      [42, '"memoryProfileId" must be a string or null.'],
    ];
    for (const [value, message] of cases) {
      const res = await send('PATCH', '/api/settings', { memoryProfileId: value });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: message });
    }
    expect(container.store.settings.get()).toEqual({ memoryProfileId: 'profile-big' });
  });

  it('archiving or deleting the memory model profile clears the setting; other profiles leave it alone', async () => {
    container.store.settings.update({ memoryProfileId: 'profile-cheap' });
    await send('PATCH', '/api/profiles/profile-big', { archivedAt: 5 });
    expect(container.store.settings.get().memoryProfileId).toBe('profile-cheap');

    await send('PATCH', '/api/profiles/profile-cheap', { archivedAt: 5 });
    expect(container.store.settings.get().memoryProfileId).toBeNull();

    container.store.settings.update({ memoryProfileId: 'profile-big' });
    expect((await send('DELETE', '/api/profiles/profile-big')).status).toBe(204);
    expect(container.store.settings.get().memoryProfileId).toBeNull();
  });
});
