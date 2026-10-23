import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { canonicalHost } from '@otherbench/core/domain/network-hosts.js';
import { DEFAULT_SANDBOX_HOSTS } from '@otherbench/core/types/config.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@otherbench/core/testing/fakes.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { FakeComputerDriver } from '@otherbench/core/testing/fake-computer.js';
import { createApp } from '../../src/app.js';
import { sandboxHostProblem } from '../../src/validation.js';
import { ComputerSessions } from '../../src/computer/sessions.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;
let dataDir: string;

// A REAL, temp-dir-backed BlobStore -- see chats.test.ts's identical
// comment for why a `{} as never` placeholder is no longer safe to use
// here: DELETE /api/profiles/:id now runs the real blob-GC sweep, and a
// mis-wired blobStore would 500 every DELETE test instead of exercising
// anything real (task 32 fix round 1, Minor #8).
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'otherbench-profiles-route-test-'));
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
  container.store.connections.create({
    id: 'conn-1',
    name: 'Conn',
    kind: 'openai',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
  });
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function app() {
  return createApp(container);
}

const basicProfileBody = {
  name: 'Default Chat',
  connectionId: 'conn-1',
  modelId: 'gpt-4o',
};

describe('POST /api/profiles', () => {
  it('creates a profile with sensible defaults for params/toolPolicy', async () => {
    const res = await app().request('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basicProfileBody),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      name: 'Default Chat',
      connectionId: 'conn-1',
      modelId: 'gpt-4o',
      isDefault: false,
      archivedAt: null,
    });
    expect((body as { toolPolicy: unknown }).toolPolicy).toMatchObject({ fs: 'off', shell: false });
  });

  it('accepts a full profile body including systemPrompt, params, and toolPolicy', async () => {
    const res = await app().request('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...basicProfileBody,
        systemPrompt: 'You are helpful.',
        params: { temperature: 0.7 },
        toolPolicy: { fs: 'read', shell: true, mcpServerIds: ['mcp-1'], approvalMode: 'ask_on_mutate' },
        colour: '#ff0000',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      systemPrompt: 'You are helpful.',
      params: { temperature: 0.7 },
      colour: '#ff0000',
    });
  });

  it('keeps toolPolicy.artifacts, and refuses a non-boolean', async () => {
    const post = (toolPolicy: unknown) =>
      app().request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basicProfileBody, toolPolicy }) });
    const created = await post({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', artifacts: false });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { toolPolicy: { artifacts?: boolean } }).toolPolicy.artifacts).toBe(false);
    expect((await post({ artifacts: 'yes' })).status).toBe(400);
  });

  it('keeps toolPolicy.browser and its blocked sites, normalised, and refuses bad ones naming the line', async () => {
    const post = (toolPolicy: unknown) =>
      app().request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basicProfileBody, toolPolicy }) });
    const base = { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' };
    const created = await post({ ...base, browser: true, browserBlockedHosts: ['Example.COM', ' *.ads.test ', 'example.com', 'bücher.example'] });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { toolPolicy: unknown }).toolPolicy).toMatchObject({ browser: true, browserBlockedHosts: ['example.com', 'ads.test', 'xn--bcher-kva.example'] });
    expect((await post({ ...base, browser: 'yes' })).status).toBe(400);
    const pasted = await post({ ...base, browser: true, browserBlockedHosts: ['ok.test', 'https://example.com/'] });
    expect(pasted.status).toBe(400);
    expect(((await pasted.json()) as { error: string }).error).toBe(`"https://example.com/" isn't a website name. Use a name like example.com, one per line.`);
    expect((await post({ ...base, browserBlockedHosts: 'example.com' })).status).toBe(400);
    expect((await post({ ...base, browserBlockedHosts: Array.from({ length: 201 }, (_, i) => `s${i}.test`) })).status).toBe(400);
    expect((await post({ ...base, browserBlockedHosts: Array.from({ length: 200 }, (_, i) => `s${i}.test`) })).status).toBe(201);
  });

  it('refuses a blocked-site entry that is not a plain hostname or IP address, naming it', async () => {
    const post = (entry: string) =>
      app().request('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...basicProfileBody, toolPolicy: { browserBlockedHosts: [entry] } }),
      });
    for (const bad of ['*', '*.', '.ads.test', 'ads.test.', 'ads.test:80', 'https://ads.test', 'ads.test/path', 'a..test', 'ads.*.test', 'user@ads.test', 'ads test', '', '   ', '-', 'a_b.test']) {
      const res = await post(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(`"${bad}"`);
    }
    for (const good of ['ads.test', 'EXAMPLE.org', 'a-b.c-d.example', '127.0.0.1', '::1', '[::1]', 'xn--bcher-kva.example']) {
      expect((await post(good)).status, good).toBe(201);
    }
  });

  it('keeps toolPolicy.recall, and refuses a non-boolean', async () => {
    const post = (toolPolicy: unknown) =>
      app().request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basicProfileBody, toolPolicy }) });
    const created = await post({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', recall: false });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { toolPolicy: { recall?: boolean } }).toolPolicy.recall).toBe(false);
    expect((await post({ recall: 'yes' })).status).toBe(400);
  });

  it('keeps toolPolicy.subagents, and refuses a non-boolean', async () => {
    const post = (toolPolicy: unknown) =>
      app().request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basicProfileBody, toolPolicy }) });
    const created = await post({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', subagents: true });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { toolPolicy: { subagents?: boolean } }).toolPolicy.subagents).toBe(true);
    const plain = await post({ fs: 'off' });
    expect(((await plain.json()) as { toolPolicy: Record<string, unknown> }).toolPolicy).not.toHaveProperty('subagents');
    expect((await post({ subagents: 'yes' })).status).toBe(400);
  });

  it('keeps toolPolicy.computer (off unless it is turned on), and refuses a non-boolean', async () => {
    const post = (toolPolicy: unknown) =>
      app().request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basicProfileBody, toolPolicy }) });
    const patch = (id: string, toolPolicy: unknown) =>
      app().request(`/api/profiles/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolPolicy }) });
    type Body = { id: string; toolPolicy: { computer?: boolean; fs: string } };

    // Off by default: a profile that never mentions it has no `computer` at all, with or without a toolPolicy.
    const plain = (await (await post(undefined)).json()) as Body;
    expect('computer' in plain.toolPolicy).toBe(false);
    const other = (await (await post({ fs: 'read', browser: true })).json()) as Body;
    expect('computer' in other.toolPolicy).toBe(false);

    const created = await post({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', computer: true });
    expect(created.status).toBe(201);
    const profile = (await created.json()) as Body;
    expect(profile.toolPolicy.computer).toBe(true);
    expect(container.store.profiles.get(profile.id)?.toolPolicy.computer).toBe(true);

    // Only a boolean turns it on or off.
    for (const bad of ['yes', 'true', 1, null, {}, []]) {
      const res = await post({ computer: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(((await res.json()) as { error: string }).error, JSON.stringify(bad)).toContain('"toolPolicy.computer" must be a boolean.');
      expect((await patch(plain.id, { computer: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect('computer' in container.store.profiles.get(plain.id)!.toolPolicy).toBe(false);

    // A partial PATCH that does not mention it keeps it; one that does changes it.
    const kept = (await (await patch(profile.id, { fs: 'read' })).json()) as Body;
    expect(kept.toolPolicy).toMatchObject({ fs: 'read', computer: true });
    const off = (await (await patch(profile.id, { computer: false })).json()) as Body;
    expect(off.toolPolicy.computer).toBe(false);
    expect(container.store.profiles.get(profile.id)?.toolPolicy.computer).toBe(false);
  });

  it("turning computer use off on a profile ends the session of the chat using it and cancels that chat's replies, and no other chat's", async () => {
    const driver = new FakeComputerDriver();
    const cancelled: string[] = [];
    const sessions = new ComputerSessions(driver, { emit: () => {}, cancelChat: (chatId) => cancelled.push(chatId), chatExists: (chatId) => container.store.chats.get(chatId) !== null });
    container.computer = sessions;
    const make = async (toolPolicy: unknown): Promise<string> => {
      const res = await app().request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basicProfileBody, toolPolicy }) });
      return ((await res.json()) as { id: string }).id;
    };
    // While the computer is in control, changes come only from the desktop app's own window.
    const DESKTOP = 'http://tauri.localhost';
    const patch = (id: string, toolPolicy: unknown) =>
      createApp(container, { corsOrigins: [DESKTOP] }).request(`/api/profiles/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: DESKTOP },
        body: JSON.stringify({ toolPolicy }),
      });
    const on = { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', computer: true };
    const used = await make(on);
    const other = await make(on);
    for (const [id, profileId] of [['chat-1', used], ['chat-2', other]] as const) {
      container.store.chats.create({ id, title: id, profileId, headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    }
    expect(await sessions.ensureSession('chat-1', 'chat-1')).toMatchObject({ ok: true });

    // A change that leaves it on, and turning it off on a profile no chat in control uses, change nothing.
    expect((await patch(used, { fs: 'read' })).status).toBe(200);
    expect((await patch(other, { computer: false })).status).toBe(200);
    expect(sessions.activeChat()).toBe('chat-1');
    expect(driver.ended).toEqual([]);
    expect(cancelled).toEqual([]);

    // Unticking it on the profile the chat in control uses is Stop for that chat.
    expect((await patch(used, { computer: false })).status).toBe(200);
    expect(sessions.activeChat()).toBeNull();
    expect(driver.ended).toEqual(['chat-1']);
    expect(cancelled).toEqual(['chat-1']);
  });

  it('rejects a missing name with 400', async () => {
    const res = await app().request('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: 'conn-1', modelId: 'gpt-4o' }),
    });
    expect(res.status).toBe(400);
  });

  it('MINOR 13: rejects a non-string entry in toolPolicy.mcpServerIds with 400 instead of letting it round-trip into storage', async () => {
    // A `null`/number/object entry survives a bare `Array.isArray` check
    // and, once stored, defeats PermissionBroker's `mcpServerIds.length ===
    // 0` fast-deny path (see permissions.ts) without ever matching a real
    // server id -- harmless in effect, but the array should never have
    // been allowed to hold it in the first place.
    const res = await app().request('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basicProfileBody, toolPolicy: { mcpServerIds: ['real-server', 42, null, { a: 1 }] } }),
    });
    expect(res.status).toBe(400);
  });

  it('still accepts an all-string mcpServerIds array', async () => {
    const res = await app().request('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basicProfileBody, toolPolicy: { mcpServerIds: ['srv-1', 'srv-2'] } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { toolPolicy: { mcpServerIds: string[] } };
    expect(body.toolPolicy.mcpServerIds).toEqual(['srv-1', 'srv-2']);
  });
});

describe('GET /api/profiles', () => {
  it('lists profiles', async () => {
    await app().request('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basicProfileBody),
    });
    const res = await app().request('/api/profiles');
    expect(await res.json()).toHaveLength(1);
  });
});

describe('GET /api/profiles/:id', () => {
  it('returns 404 for an unknown id', async () => {
    const res = await app().request('/api/profiles/nope');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/profiles/:id', () => {
  it('updates fields', async () => {
    const created = await (
      await app().request('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicProfileBody),
      })
    ).json();

    const res = await app().request(`/api/profiles/${(created as { id: string }).id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', isDefault: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Renamed', isDefault: true });
  });
});

describe('toolPolicy agent fields', () => {
  it('accepts and round-trips agentWeb/agentMcp, and rejects non-booleans', async () => {
    const created = await app().request('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...basicProfileBody,
        toolPolicy: { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate', agentWeb: false, agentMcp: true, agentUserSettings: true },
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; toolPolicy: unknown };
    expect(body.toolPolicy).toMatchObject({ agentWeb: false, agentMcp: true, agentUserSettings: true });

    const badUser = await app().request(`/api/profiles/${body.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolPolicy: { agentUserSettings: 'yes' } }),
    });
    expect(badUser.status).toBe(400);

    const bad = await app().request(`/api/profiles/${body.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolPolicy: { agentWeb: 'no' } }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: '"toolPolicy.agentWeb" must be a boolean.' });
  });
});

describe('DELETE /api/profiles/:id', () => {
  it('deletes the profile', async () => {
    const created = await (
      await app().request('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(basicProfileBody),
      })
    ).json();

    const res = await app().request(`/api/profiles/${(created as { id: string }).id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(container.store.profiles.get((created as { id: string }).id)).toBeNull();
  });

  it("closes the engine's processes for the chats that went with it", async () => {
    const created = (await (await app().request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(basicProfileBody) })).json()) as { id: string };
    container.store.chats.create({ id: 'chat-gone', title: 'T', profileId: created.id, headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const closeChats = vi.fn();
    container.engine.closeChats = closeChats;

    expect((await app().request(`/api/profiles/${created.id}`, { method: 'DELETE' })).status).toBe(204);

    expect(closeChats).toHaveBeenCalledTimes(1);
    const gone = closeChats.mock.calls[0]![0] as (chatId: string) => boolean;
    expect(gone('chat-gone')).toBe(true);
  });
});

describe('PATCH /api/profiles/:id toolPolicy merging', () => {
  const full = {
    fs: 'readwrite',
    shell: true,
    mcpServerIds: ['mcp-1', 'mcp-2'],
    approvalMode: 'ask_on_mutate',
    agentWeb: false,
    agentMcp: true,
  };

  async function createWithPolicy(): Promise<string> {
    const res = await app().request('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basicProfileBody, toolPolicy: full }),
    });
    return ((await res.json()) as { id: string }).id;
  }

  function patch(id: string, toolPolicy: unknown) {
    return app().request(`/api/profiles/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolPolicy }),
    });
  }

  it('a partial toolPolicy keeps mcpServerIds and every other untouched field', async () => {
    const id = await createWithPolicy();
    const res = await patch(id, { fs: 'read' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { toolPolicy: unknown }).toolPolicy).toEqual({ ...full, fs: 'read' });
    expect(container.store.profiles.get(id)?.toolPolicy).toEqual({ ...full, fs: 'read' });
  });

  it('each single-field patch changes only that field', async () => {
    const id = await createWithPolicy();
    await patch(id, { shell: false });
    await patch(id, { approvalMode: 'always_ask' });
    await patch(id, { mcpServerIds: ['mcp-3'] });
    await patch(id, { agentWeb: true });
    expect(container.store.profiles.get(id)?.toolPolicy).toEqual({
      fs: 'readwrite',
      shell: false,
      mcpServerIds: ['mcp-3'],
      approvalMode: 'always_ask',
      agentWeb: true,
      agentMcp: true,
    });
  });

  it('an explicit empty mcpServerIds still clears the list', async () => {
    const id = await createWithPolicy();
    await patch(id, { mcpServerIds: [] });
    expect(container.store.profiles.get(id)?.toolPolicy.mcpServerIds).toEqual([]);
  });

  it('a full toolPolicy still replaces the whole policy', async () => {
    const id = await createWithPolicy();
    const next = { fs: 'off', shell: false, mcpServerIds: ['x'], approvalMode: 'always_ask' };
    const res = await patch(id, next);
    expect(res.status).toBe(200);
    // agentWeb/agentMcp were not sent; they carry over (they are optional and untouched).
    expect(container.store.profiles.get(id)?.toolPolicy).toMatchObject(next);
  });

  it('an empty toolPolicy object changes nothing', async () => {
    const id = await createWithPolicy();
    await patch(id, {});
    expect(container.store.profiles.get(id)?.toolPolicy).toEqual(full);
  });

  it('invalid values are still 400 and leave the policy untouched', async () => {
    const id = await createWithPolicy();
    for (const bad of [{ fs: 'write' }, { approvalMode: 'never' }, { mcpServerIds: ['a', 1] }, { agentMcp: 'yes' }, 'nope', [1]]) {
      const res = await patch(id, bad);
      expect(res.status).toBe(400);
    }
    expect(container.store.profiles.get(id)?.toolPolicy).toEqual(full);
  });

  it('POST still defaults every omitted field', async () => {
    const res = await app().request('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basicProfileBody, toolPolicy: { fs: 'read' } }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { toolPolicy: unknown }).toolPolicy).toEqual({
      fs: 'read',
      shell: false,
      mcpServerIds: [],
      approvalMode: 'always_ask',
    });
  });
});

describe('toolPolicy: the sandboxed shell', () => {
  const create = (toolPolicy: unknown) =>
    app().request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basicProfileBody, toolPolicy }) });
  const patch = (id: string, toolPolicy: unknown) =>
    app().request(`/api/profiles/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolPolicy }) });

  it('stores shellRuns and a tidied allowlist', async () => {
    const res = await create({ fs: 'readwrite', shell: true, shellRuns: 'sandbox', sandboxHosts: ['  PyPI.org ', '*.example.com', 'api.example.com:8443', 'pypi.org'] });
    expect(res.status).toBe(201);
    expect((await res.json()).toolPolicy).toMatchObject({ shellRuns: 'sandbox', sandboxHosts: ['pypi.org', '*.example.com', 'api.example.com:8443'] });
  });

  it('a partial PATCH keeps them, and sandboxHosts: null goes back to the defaults', async () => {
    const created = await (await create({ shell: true, shellRuns: 'sandbox', sandboxHosts: ['pypi.org'] })).json();
    const kept = await (await patch(created.id, { fs: 'read' })).json();
    expect(kept.toolPolicy).toMatchObject({ fs: 'read', shellRuns: 'sandbox', sandboxHosts: ['pypi.org'] });
    const reset = await (await patch(created.id, { sandboxHosts: null })).json();
    expect(reset.toolPolicy.sandboxHosts).toBeUndefined();
    expect(reset.toolPolicy.shellRuns).toBe('sandbox');
    const host = await (await patch(created.id, { shellRuns: 'host' })).json();
    expect(host.toolPolicy.shellRuns).toBe('host');
  });

  it.each([...DEFAULT_SANDBOX_HOSTS])('the default allowlist host %s passes the validation and is already canonical', (host) => {
    expect(sandboxHostProblem(host)).toBeNull();
    expect(canonicalHost(host)).toBe(host);
  });

  it('accepts every default allowlist host', async () => {
    const res = await create({ shell: true, shellRuns: 'sandbox', sandboxHosts: [...DEFAULT_SANDBOX_HOSTS] });
    expect(res.status).toBe(201);
    expect((await res.json()).toolPolicy.sandboxHosts).toEqual([...DEFAULT_SANDBOX_HOSTS]);
  });

  it("still accepts GitHub in a profile's own list, though it is no longer a default", async () => {
    const hosts = ['github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com'];
    const res = await create({ shell: true, shellRuns: 'sandbox', sandboxHosts: hosts });
    expect(res.status).toBe(201);
    expect((await res.json()).toolPolicy.sandboxHosts).toEqual(hosts);
  });

  it.each([
    [{ shellRuns: 'vm' }, '"toolPolicy.shellRuns" must be one of: host, sandbox.'],
    [{ sandboxHosts: 'pypi.org' }, '"toolPolicy.sandboxHosts" must be an array of strings, or null for the defaults.'],
    [{ sandboxHosts: ['1.2.3.4'] }, '"toolPolicy.sandboxHosts": "1.2.3.4" is an IP address; name the host instead.'],
    [{ sandboxHosts: ['[::1]:22'] }, '"toolPolicy.sandboxHosts": "[::1]:22" is an IP address; name the host instead.'],
    [{ sandboxHosts: ['localhost'] }, '"toolPolicy.sandboxHosts": "localhost" is this machine, which the sandbox never reaches.'],
    [{ sandboxHosts: ['api.localhost'] }, '"toolPolicy.sandboxHosts": "api.localhost" is this machine, which the sandbox never reaches.'],
    [{ sandboxHosts: ['intranet'] }, '"toolPolicy.sandboxHosts": "intranet" must be a full host name like pypi.org.'],
    [{ sandboxHosts: ['pypi.org:0'] }, '"toolPolicy.sandboxHosts": "pypi.org:0" has a port outside 1-65535.'],
    [{ sandboxHosts: ['bad_host.org'] }, '"toolPolicy.sandboxHosts": "bad_host.org" isn\'t a host name pattern (letters, digits, hyphens and dots, optionally starting with *.).'],
    [{ sandboxHosts: [`${'a'.repeat(250)}.org`] }, `"toolPolicy.sandboxHosts": "${'a'.repeat(250)}.org" is longer than 253 characters.`],
    [{ sandboxHosts: Array.from({ length: 201 }, (_, i) => `h${i}.example.com`) }, '"toolPolicy.sandboxHosts" may list at most 200 hosts.'],
  ])('refuses %j', async (toolPolicy, message) => {
    const res = await create(toolPolicy);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message });
  });
});

describe('media policy and generation connections', () => {
  function addConn(id: string, kind: 'comfyui' | 'mock' | 'a1111'): void {
    container.store.connections.create({ id, name: id, kind, baseUrl: kind === 'mock' ? null : 'http://127.0.0.1:8188', secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
  }
  async function makeProfile(): Promise<string> {
    const res = await app().request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(basicProfileBody) });
    return ((await res.json()) as { id: string }).id;
  }
  function patch(id: string, body: unknown): Promise<Response> {
    return app().request(`/api/profiles/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  it("refuses a generation connection as a profile's chat model", async () => {
    addConn('gen-1', 'comfyui');
    const res = await app().request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basicProfileBody, connectionId: 'gen-1' }) });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("A generation connection can't be a profile's chat model.");
    const id = await makeProfile();
    expect((await patch(id, { connectionId: 'gen-1' })).status).toBe(400);
  });

  it('stores and reads back toolPolicy.media, and keeps it on a later partial patch', async () => {
    addConn('gen-1', 'comfyui');
    const id = await makeProfile();
    const media = { image: { connectionId: 'gen-1', model: 'builtin:sdxl-txt2img' } };
    const res = await patch(id, { toolPolicy: { media } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { toolPolicy: { media: unknown } }).toolPolicy.media).toEqual(media);
    await patch(id, { toolPolicy: { fs: 'read' } });
    const got = (await (await app().request(`/api/profiles/${id}`)).json()) as { toolPolicy: { media: unknown } };
    expect(got.toolPolicy.media).toEqual(media);
  });

  it('rejects a media choice naming a chat connection, and video on a non-comfyui connection', async () => {
    addConn('mock', 'mock');
    addConn('a1', 'a1111');
    const id = await makeProfile();
    expect((await patch(id, { toolPolicy: { media: { image: { connectionId: 'mock', model: 'm' } } } })).status).toBe(400);
    expect((await patch(id, { toolPolicy: { media: { video: { connectionId: 'a1', model: 'm' } } } })).status).toBe(400);
    expect((await patch(id, { toolPolicy: { media: { image: { connectionId: 'a1', model: '' } } } })).status).toBe(400);
  });

  it('stores a ComfyUI choice\'s model file, and refuses a bad one or one on another kind', async () => {
    addConn('gen-1', 'comfyui');
    addConn('a1', 'a1111');
    const id = await makeProfile();
    const image = { connectionId: 'gen-1', model: 'builtin:sdxl-txt2img', checkpoint: 'juggernaut.safetensors' };
    const res = await patch(id, { toolPolicy: { media: { image } } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { toolPolicy: { media: { image: unknown } } }).toolPolicy.media.image).toEqual(image);
    for (const checkpoint of ['', 7, 'x'.repeat(513)]) {
      expect((await patch(id, { toolPolicy: { media: { image: { ...image, checkpoint } } } })).status).toBe(400);
    }
    const other = await patch(id, { toolPolicy: { media: { image: { connectionId: 'a1', model: 'sd15', checkpoint: 'x.safetensors' } } } });
    expect(other.status).toBe(400);
    expect(JSON.stringify(await other.json())).toContain('ComfyUI');
    expect((await patch(id, { toolPolicy: { media: { image: { ...image, checkpoint: 'x'.repeat(512) } } } })).status).toBe(200);
  });

  it('rejects a non-boolean confirmPrompts', async () => {
    const id = await makeProfile();
    expect((await patch(id, { toolPolicy: { media: { confirmPrompts: 'yes' } } })).status).toBe(400);
  });
});
