import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { SandboxError, type Sandbox, type SandboxStatus } from '@grunt/core/ports/sandbox.js';
import { FakeChatEngine, FakeSandbox, FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import { UnsupportedSandbox } from '@grunt/sandbox/unsupported-sandbox.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { forwardedApi } from '../../src/peer/forward.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'grunt-sandbox-route-test-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function makeContainer(sandbox: Sandbox | undefined): Container {
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  store.connections.create({ id: 'conn-1', name: 'Conn', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  store.profiles.create({
    id: 'profile-1', name: 'P', description: null, colour: null, connectionId: 'conn-1', modelId: 'm', systemPrompt: null, params: {},
    toolPolicy: { fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: [], approvalMode: 'ask_on_mutate' }, isDefault: true, archivedAt: null,
  });
  store.chats.create({ id: 'chat-1', title: 'T', profileId: 'profile-1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  return {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dataDir, 'attachments')),
    ...(sandbox ? { sandbox } : {}),
    close: () => {},
  };
}
const send = (container: Container, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  createApp(container).request(path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** A sandbox whose setup is already running (or whose Remove and package changes refuse as busy). */
class BusySandbox extends FakeSandbox {
  override async status(): Promise<SandboxStatus> {
    return { state: 'setting_up', log: ['Installing Node'], packages: [], machine: 'This machine' };
  }
  override async remove(): Promise<void> {
    throw new SandboxError('busy', "The sandbox is being set up. Remove it when that's finished.");
  }
  override async setPackages(): Promise<void> {
    throw new SandboxError('busy', "The sandbox is being set up. Change its packages when that's finished.");
  }
}

describe('/api/sandbox', () => {
  it('reports the status, sets up in the background, and removes', async () => {
    const sandbox = new FakeSandbox();
    const c = makeContainer(sandbox);
    expect(await (await send(c, 'GET', '/api/sandbox')).json()).toEqual({ state: 'not_set_up', packages: [], machine: 'This machine' });
    const started = await send(c, 'POST', '/api/sandbox/setup');
    expect(started.status).toBe(202);
    expect(sandbox.setupCalls).toBe(1);
    expect((await (await send(c, 'GET', '/api/sandbox')).json()).state).toBe('ready');
    const removed = await send(c, 'POST', '/api/sandbox/remove');
    expect(removed.status).toBe(200);
    expect((await removed.json()).state).toBe('not_set_up');
  });

  it('reads the status without starting anything', async () => {
    const sandbox = new FakeSandbox();
    await send(makeContainer(sandbox), 'GET', '/api/sandbox');
    expect(sandbox.setupCalls).toBe(0);
  });

  it('refuses to set up where the sandbox is unsupported', async () => {
    const res = await send(makeContainer(new UnsupportedSandbox()), 'POST', '/api/sandbox/setup');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The sandbox isn't available on this platform yet." });
  });

  it('does not start a second setup while one is running; it answers with the running one', async () => {
    const sandbox = new BusySandbox();
    const res = await send(makeContainer(sandbox), 'POST', '/api/sandbox/setup');
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ state: 'setting_up', log: ['Installing Node'] });
    expect(sandbox.setupCalls).toBe(0);
  });

  it('turns a refusal from the sandbox into a 409 with its message', async () => {
    const c = makeContainer(new BusySandbox());
    const removed = await send(c, 'POST', '/api/sandbox/remove');
    expect(removed.status).toBe(409);
    expect(await removed.json()).toEqual({ error: "The sandbox is being set up. Remove it when that's finished." });
    const packages = await send(c, 'PUT', '/api/sandbox/packages', { packages: ['ffmpeg'] });
    expect(packages.status).toBe(409);
    expect(await packages.json()).toEqual({ error: "The sandbox is being set up. Change its packages when that's finished." });
  });

  it('stores the extra packages, and refuses a list that is not one', async () => {
    const c = makeContainer(new FakeSandbox({ ready: true }));
    const ok = await send(c, 'PUT', '/api/sandbox/packages', { packages: [' ffmpeg ', 'pandoc', 'ffmpeg', 'g++'] });
    expect(ok.status).toBe(202);
    expect((await ok.json()).packages).toEqual(['ffmpeg', 'pandoc', 'g++']);
    for (const [packages, message] of [
      ['ffmpeg', '"packages" must be an array of strings.'],
      [['rm -rf /'], '"rm -rf /" is not an apt package name.'],
      [['-y'], '"-y" is not an apt package name.'],
      [['foo-'], '"foo-" is not an apt package name.'],
      [['x.deb'], '"x.deb" is not an apt package name.'],
      [['a:b'], '"a:b" is not an apt package name.'],
      [Array.from({ length: 51 }, (_, i) => `p${i}`), '"packages" may list at most 50 packages.'],
    ] as const) {
      const res = await send(c, 'PUT', '/api/sandbox/packages', { packages });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: message });
    }
  });

  it('answers 400, not 500, to a body that is not an object with packages', async () => {
    const c = makeContainer(new FakeSandbox({ ready: true }));
    for (const body of [null, [], 'x', 5, {}]) {
      const res = await send(c, 'PUT', '/api/sandbox/packages', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: '"packages" must be an array of strings.' });
    }
    const notJson = await createApp(c).request('/api/sandbox/packages', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    expect(notJson.status).toBe(400);
  });

  it("answers 400 when the sandbox itself refuses a package name", async () => {
    const sandbox = new FakeSandbox({ ready: true });
    sandbox.setPackages = () => Promise.reject(new SandboxError('bad_package', '"zz" is not an apt package name.'));
    const res = await send(makeContainer(sandbox), 'PUT', '/api/sandbox/packages', { packages: ['zz'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '"zz" is not an apt package name.' });
  });

  it('is 404 when this server has no sandbox', async () => {
    expect((await send(makeContainer(undefined), 'GET', '/api/sandbox')).status).toBe(404);
  });

  it("refuses another site's page asking to set up", async () => {
    const sandbox = new FakeSandbox();
    const res = await send(makeContainer(sandbox), 'POST', '/api/sandbox/setup', undefined, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(sandbox.setupCalls).toBe(0);
  });

  it('is never served on the peer listener', async () => {
    const c = makeContainer(new FakeSandbox());
    expect((await forwardedApi(c).request('/sandbox')).status).toBe(404);
    expect((await forwardedApi(c).request('/sandbox/setup', { method: 'POST' })).status).toBe(404);
  });
});

describe('deleting chats releases their sandbox', () => {
  it('deleting a chat releases it', async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const c = makeContainer(sandbox);
    expect((await send(c, 'DELETE', '/api/chats/chat-1')).status).toBe(204);
    expect(sandbox.released).toEqual(['chat-1']);
  });

  it('deleting a profile releases each of its chats', async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const c = makeContainer(sandbox);
    expect((await send(c, 'DELETE', '/api/profiles/profile-1')).status).toBe(204);
    expect(sandbox.released).toEqual(['chat-1']);
  });

  it('releases before the orphan-blob sweep, so a sweep that fails the request leaves no sandbox behind', async () => {
    for (const [path, chats] of [['/api/chats/chat-1', ['chat-1']], ['/api/profiles/profile-1', ['chat-1']]] as const) {
      const sandbox = new FakeSandbox({ ready: true });
      const c = makeContainer(sandbox);
      // A wiring error (no root), which the sweep deliberately lets through as a 500.
      c.blobStore = {} as never;
      const err = console.error;
      console.error = () => undefined;
      try {
        expect((await send(c, 'DELETE', path)).status).toBe(500);
      } finally {
        console.error = err;
      }
      expect(sandbox.released).toEqual(chats);
    }
  });

  it('still deletes when releasing fails', async () => {
    const sandbox = new FakeSandbox({ ready: true });
    sandbox.release = () => Promise.reject(new Error('wsl went away'));
    const c = makeContainer(sandbox);
    const err = console.error;
    console.error = () => undefined;
    try {
      expect((await send(c, 'DELETE', '/api/chats/chat-1')).status).toBe(204);
    } finally {
      console.error = err;
    }
    expect(c.store.chats.get('chat-1')).toBeNull();
  });
});
