import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import { FakeComputerDriver } from '@grunt/core/testing/fake-computer.js';
import { createApp } from '../../src/app.js';
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
  dataDir = await mkdtemp(join(tmpdir(), 'grunt-profiles-route-test-'));
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
    const patch = (id: string, toolPolicy: unknown) =>
      app().request(`/api/profiles/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toolPolicy }) });
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
        toolPolicy: { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate', agentWeb: false, agentMcp: true },
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; toolPolicy: unknown };
    expect(body.toolPolicy).toMatchObject({ agentWeb: false, agentMcp: true });

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
