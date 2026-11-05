import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, PEER_COMPUTER_CONTROL_HOST_ONLY_REASON } from '@otherbench/core/domain/settings.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { AppEventBus } from '../../src/stream/events.js';
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
  dataDir = await mkdtemp(join(tmpdir(), 'otherbench-settings-route-test-'));
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
    events: new AppEventBus(),
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

/** The desktop shell's webview origin, as `--cors-origin` names it. */
const DESKTOP_ORIGIN = 'http://tauri.localhost';

/** A PATCH from a desktop server's app (its `--cors-origin`), with `origin` as the request's Origin (none: a tab or a script). */
function patchOnDesktop(body: unknown, origin?: string): Promise<Response> {
  return Promise.resolve(
    createApp(container, { corsOrigins: [DESKTOP_ORIGIN] }).request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(origin === undefined ? {} : { Origin: origin }) },
      body: JSON.stringify(body),
    })
  );
}

describe('/api/settings', () => {
  it('GET returns the defaults: no memory model', async () => {
    const res = await send('GET', '/api/settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...DEFAULT_APP_SETTINGS, memoryProfileId: null });
  });

  it('PATCH sets the memory model and null clears it', async () => {
    const set = await send('PATCH', '/api/settings', { memoryProfileId: 'profile-cheap' });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ ...DEFAULT_APP_SETTINGS, memoryProfileId: 'profile-cheap' });
    expect(await (await send('GET', '/api/settings')).json()).toEqual({ ...DEFAULT_APP_SETTINGS, memoryProfileId: 'profile-cheap' });

    expect(await (await send('PATCH', '/api/settings', { memoryProfileId: null })).json()).toEqual({ ...DEFAULT_APP_SETTINGS, memoryProfileId: null });
    expect(await (await send('PATCH', '/api/settings', {})).json()).toEqual({ ...DEFAULT_APP_SETTINGS, memoryProfileId: null });
  });

  it('GitHub and Nextcloud start on; PATCH turns them off and says so once, to every window', async () => {
    const seen: string[] = [];
    container.events!.subscribe((e) => seen.push(e.type));
    const res = await send('PATCH', '/api/settings', { githubEnabled: false, nextcloudEnabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memoryProfileId: null, githubEnabled: false, nextcloudEnabled: false, peerComputerControl: false });
    expect(seen).toEqual(['settings-changed']);
    await send('PATCH', '/api/settings', { githubEnabled: false });
    expect(seen).toEqual(['settings-changed']);
    await send('PATCH', '/api/settings', { githubEnabled: true });
    expect(container.store.settings.get()).toMatchObject({ githubEnabled: true, nextcloudEnabled: false });
  });

  it("doesn't let paired machines start and approve computer use by default; the desktop app turns it on, and it says so", async () => {
    expect(container.store.settings.get().peerComputerControl).toBe(false);
    expect(await (await send('GET', '/api/settings')).json()).toMatchObject({ peerComputerControl: false });
    const seen: string[] = [];
    container.events!.subscribe((e) => seen.push(e.type));
    const on = await patchOnDesktop({ peerComputerControl: true }, DESKTOP_ORIGIN);
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ peerComputerControl: true });
    expect(seen).toEqual(['settings-changed']);
    for (const value of ['no', null, 0]) expect((await patchOnDesktop({ peerComputerControl: value }, DESKTOP_ORIGIN)).status).toBe(400);
    expect(container.store.settings.get().peerComputerControl).toBe(true);
    expect((await patchOnDesktop({ peerComputerControl: false }, DESKTOP_ORIGIN)).status).toBe(200);
    expect(container.store.settings.get().peerComputerControl).toBe(false);
  });

  it('is turned on only from the desktop app: a tab, a script or a server with no desktop app is refused, writing nothing', async () => {
    for (const res of [await send('PATCH', '/api/settings', { peerComputerControl: true }), await patchOnDesktop({ peerComputerControl: true }), await patchOnDesktop({ peerComputerControl: true, githubEnabled: false })]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: PEER_COMPUTER_CONTROL_HOST_ONLY_REASON, kind: 'desktop_app_only' });
    }
    // Nothing else in a refused PATCH was written either.
    expect(container.store.settings.get()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('is turned off from anywhere, and a tab may send it as it already is', async () => {
    container.store.settings.update({ peerComputerControl: true });
    expect((await send('PATCH', '/api/settings', { peerComputerControl: true })).status).toBe(200);
    const off = await send('PATCH', '/api/settings', { peerComputerControl: false });
    expect(off.status).toBe(200);
    expect(container.store.settings.get().peerComputerControl).toBe(false);
    expect((await send('PATCH', '/api/settings', { peerComputerControl: false })).status).toBe(200);
  });

  it('PATCH refuses a feature switch that is not true or false, writing nothing', async () => {
    for (const body of [{ githubEnabled: 'no' }, { nextcloudEnabled: null }, { githubEnabled: false, nextcloudEnabled: 0 }]) {
      const res = await send('PATCH', '/api/settings', body);
      expect(res.status).toBe(400);
    }
    expect(container.store.settings.get()).toEqual(DEFAULT_APP_SETTINGS);
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
    expect(container.store.settings.get()).toEqual({ ...DEFAULT_APP_SETTINGS, memoryProfileId: 'profile-big' });
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
