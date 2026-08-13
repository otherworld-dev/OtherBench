import { describe, it, expect, beforeEach } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;

beforeEach(() => {
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
