import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
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
