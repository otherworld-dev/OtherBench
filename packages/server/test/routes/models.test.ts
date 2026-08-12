import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';

let container: Container;

beforeEach(() => {
  container = { store: new InMemoryStore(), secrets: new FakeSecretStore(), engine: new FakeChatEngine([]), registry: {} as never, close: () => {} };
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

describe('POST /api/models', () => {
  it('creates a manually-added model', async () => {
    const res = await app().request('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: 'conn-1', modelId: 'gpt-4o', displayName: 'GPT-4o' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ connectionId: 'conn-1', modelId: 'gpt-4o', displayName: 'GPT-4o', source: 'manual' });
  });

  it('rejects a missing connectionId with 400', async () => {
    const res = await app().request('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: 'gpt-4o', displayName: 'GPT-4o' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/models', () => {
  it('lists all models, optionally filtered by connectionId', async () => {
    await app().request('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: 'conn-1', modelId: 'gpt-4o', displayName: 'GPT-4o' }),
    });

    const all = await (await app().request('/api/models')).json();
    expect(all).toHaveLength(1);

    const filtered = await (await app().request('/api/models?connectionId=conn-1')).json();
    expect(filtered).toHaveLength(1);

    const empty = await (await app().request('/api/models?connectionId=nonexistent')).json();
    expect(empty).toHaveLength(0);
  });
});

describe('GET /api/models/:id', () => {
  it('returns 404 for an unknown id', async () => {
    const res = await app().request('/api/models/nope');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/models/:id', () => {
  it('updates fields like displayName and pricing', async () => {
    const created = await (
      await app().request('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: 'conn-1', modelId: 'gpt-4o', displayName: 'GPT-4o' }),
      })
    ).json();

    const res = await app().request(`/api/models/${(created as { id: string }).id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'GPT-4o (renamed)', priceInPer1m: 2.5 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ displayName: 'GPT-4o (renamed)', priceInPer1m: 2.5 });
  });
});

describe('DELETE /api/models/:id', () => {
  it('deletes the model', async () => {
    const created = await (
      await app().request('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: 'conn-1', modelId: 'gpt-4o', displayName: 'GPT-4o' }),
      })
    ).json();

    const res = await app().request(`/api/models/${(created as { id: string }).id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(container.store.models.get((created as { id: string }).id)).toBeNull();
  });
});
