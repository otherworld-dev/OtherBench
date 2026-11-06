import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  PEER_COMPUTER_CONTROL_CONFIRM_TEXT,
  PEER_COMPUTER_CONTROL_HOST_ONLY_REASON,
  PEER_COMPUTER_CONTROL_IN_CONTROL_REASON,
  PEER_COMPUTER_CONTROL_NO_DESKTOP_REASON,
  peerComputerControlNotConfirmedReason,
} from '@otherbench/core/domain/settings.js';
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

/** Gives the container a desktop app whose native question answers `answer`; returns the questions it was asked. */
function confirmWith(answer: { ok: true } | { ok: false; reason: string }): string[] {
  const asked: string[] = [];
  container = { ...container, hostConfirm: { confirm: async (text: string) => (asked.push(text), answer) } };
  return asked;
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
    expect(await res.json()).toEqual({ memoryProfileId: null, githubEnabled: false, nextcloudEnabled: false, peerComputerControl: false, handoverEnabled: true, handoverThresholdTokens: 300_000 });
    expect(seen).toEqual(['settings-changed']);
    await send('PATCH', '/api/settings', { githubEnabled: false });
    expect(seen).toEqual(['settings-changed']);
    await send('PATCH', '/api/settings', { githubEnabled: true });
    expect(container.store.settings.get()).toMatchObject({ githubEnabled: true, nextcloudEnabled: false });
  });

  it("doesn't let paired machines start and approve computer use by default; the person here confirms it in the desktop app, and it says so", async () => {
    expect(container.store.settings.get().peerComputerControl).toBe(false);
    expect(await (await send('GET', '/api/settings')).json()).toMatchObject({ peerComputerControl: false });
    const asked = confirmWith({ ok: true });
    const seen: string[] = [];
    container.events!.subscribe((e) => seen.push(e.type));
    const on = await patchOnDesktop({ peerComputerControl: true }, DESKTOP_ORIGIN);
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ peerComputerControl: true });
    // The native question was asked, once, with core's words.
    expect(asked).toEqual([PEER_COMPUTER_CONTROL_CONFIRM_TEXT]);
    expect(seen).toEqual(['settings-changed']);
    for (const value of ['no', null, 0]) expect((await patchOnDesktop({ peerComputerControl: value }, DESKTOP_ORIGIN)).status).toBe(400);
    expect(container.store.settings.get().peerComputerControl).toBe(true);
    // Turning it off asks nobody.
    expect((await patchOnDesktop({ peerComputerControl: false }, DESKTOP_ORIGIN)).status).toBe(200);
    expect(container.store.settings.get().peerComputerControl).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it("a forged desktop Origin isn't enough: with no OK from the person here (declined, unanswered, or no desktop app to ask) it stays off and nothing in the request is written", async () => {
    // No desktop app to ask (a headless server, or the desktop app isn't running it).
    const none = await patchOnDesktop({ peerComputerControl: true, githubEnabled: false }, DESKTOP_ORIGIN);
    expect(none.status).toBe(403);
    expect(await none.json()).toEqual({ error: PEER_COMPUTER_CONTROL_NO_DESKTOP_REASON, kind: 'desktop_app_only' });
    for (const reason of ['The person at this computer said no.', 'Nobody answered on this computer in time.', "The desktop app didn't answer in time."]) {
      const asked = confirmWith({ ok: false, reason });
      const res = await patchOnDesktop({ peerComputerControl: true, githubEnabled: false }, DESKTOP_ORIGIN);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: peerComputerControlNotConfirmedReason(reason), kind: 'not_confirmed' });
      expect(asked).toHaveLength(1);
    }
    // A confirmer that fails outright is a no too.
    container = { ...container, hostConfirm: { confirm: () => Promise.reject(new Error('channel broke')) } };
    expect((await patchOnDesktop({ peerComputerControl: true }, DESKTOP_ORIGIN)).status).toBe(403);
    expect(container.store.settings.get()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('asks nobody while computer use may be in control here, and only one question at a time', async () => {
    const asked = confirmWith({ ok: true });
    const base = container;
    container = { ...base, computer: { mayBeInControl: () => true } as never };
    const held = await patchOnDesktop({ peerComputerControl: true }, DESKTOP_ORIGIN);
    expect(held.status).toBe(403);
    expect(await held.json()).toEqual({ error: PEER_COMPUTER_CONTROL_IN_CONTROL_REASON, kind: 'desktop_only' });
    expect(asked).toEqual([]);

    container = base;
    let answer: (a: { ok: true }) => void = () => {};
    container = { ...container, hostConfirm: { confirm: () => new Promise((resolve) => (answer = resolve)) } };
    const app = createApp(container, { corsOrigins: [DESKTOP_ORIGIN] });
    const patch = (): Promise<Response> =>
      Promise.resolve(app.request('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: DESKTOP_ORIGIN }, body: JSON.stringify({ peerComputerControl: true }) }));
    const first = patch();
    await new Promise((r) => setTimeout(r, 0));
    const second = await patch();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ kind: 'already_asking' });
    answer({ ok: true });
    expect((await first).status).toBe(200);
    expect(container.store.settings.get().peerComputerControl).toBe(true);
  });

  it("is refused before anyone is asked from a tab or a script that doesn't claim the desktop app's Origin, writing nothing", async () => {
    const asked = confirmWith({ ok: true });
    for (const res of [await send('PATCH', '/api/settings', { peerComputerControl: true }), await patchOnDesktop({ peerComputerControl: true }), await patchOnDesktop({ peerComputerControl: true, githubEnabled: false })]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: PEER_COMPUTER_CONTROL_HOST_ONLY_REASON, kind: 'desktop_app_only' });
    }
    // No dialog popped up here for any of them, and nothing else in a refused PATCH was written either.
    expect(asked).toEqual([]);
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
