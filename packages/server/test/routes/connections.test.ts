import { describe, it, expect, beforeEach } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import type { ConnectionTestResult, DiscoveredModel } from '@grunt/core/ports/chat-engine.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;
let secrets: FakeSecretStore;
let engine: FakeChatEngine;

beforeEach(() => {
  secrets = new FakeSecretStore();
  engine = new FakeChatEngine([]);
  const store = new InMemoryStore();
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store,
    secrets,
    engine,
    registry: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner),
    close: () => {},
  };
});

function app() {
  return createApp(container);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('POST /api/connections', () => {
  it('creates a connection and stores the apiKey only in SecretStore, under a conn:<id> ref', async () => {
    const res = await app().request('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My Anthropic', kind: 'anthropic', apiKey: 'sk-ant-super-secret' }),
    });

    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body['secretRef']).toMatch(/^conn:/);
    expect(body['id']).toBeTruthy();

    // The plaintext key is nowhere in the JSON response.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('sk-ant-super-secret');
    expect(raw).not.toContain('apiKey');

    // But it really was persisted, via SecretStore, under the returned ref.
    const ref = body['secretRef'] as string;
    expect(await secrets.get(ref)).toBe('sk-ant-super-secret');

    // And the DB-facing repo itself never saw the plaintext key -- only
    // whatever `Connection` fields the response also exposes.
    const stored = container.store.connections.get(body['id'] as string);
    expect(stored?.secretRef).toBe(ref);
    expect(JSON.stringify(stored)).not.toContain('sk-ant-super-secret');
  });

  it('creates a connection with no apiKey and leaves secretRef null', async () => {
    const res = await app().request('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Local Ollama', kind: 'ollama' }),
    });

    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body['secretRef']).toBeNull();
  });

  it('rejects a missing name with 400', async () => {
    const res = await app().request('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'anthropic' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid kind with 400', async () => {
    const res = await app().request('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', kind: 'not-a-real-provider' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/connections and GET /api/connections/:id', () => {
  it('never includes an apiKey field, even after a key was set', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Has A Key', kind: 'openai', apiKey: 'sk-openai-secret-value' }),
      })
    );

    const listRes = await app().request('/api/connections');
    const listBody = await listRes.json();
    expect(JSON.stringify(listBody)).not.toContain('sk-openai-secret-value');
    expect(JSON.stringify(listBody)).not.toContain('apiKey');

    const getRes = await app().request(`/api/connections/${created['id']}`);
    const getBody = await getRes.json();
    expect(JSON.stringify(getBody)).not.toContain('sk-openai-secret-value');
    expect(JSON.stringify(getBody)).not.toContain('apiKey');
    expect((getBody as Record<string, unknown>)['secretRef']).toBe(created['secretRef']);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await app().request('/api/connections/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/connections/:id', () => {
  it('rotates the apiKey in place without ever echoing it back', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Rotate Me', kind: 'openai', apiKey: 'sk-old-key' }),
      })
    );
    const id = created['id'] as string;
    const originalRef = created['secretRef'] as string;

    const patchRes = await app().request(`/api/connections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-new-key' }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(JSON.stringify(patched)).not.toContain('sk-new-key');
    expect((patched as Record<string, unknown>)['secretRef']).toBe(originalRef);

    expect(await secrets.get(originalRef)).toBe('sk-new-key');
  });

  it('clears the apiKey when apiKey: null is sent', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Clear Me', kind: 'openai', apiKey: 'sk-to-clear' }),
      })
    );
    const id = created['id'] as string;
    const ref = created['secretRef'] as string;

    const patchRes = await app().request(`/api/connections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: null }),
    });
    const patched = await patchRes.json();
    expect((patched as Record<string, unknown>)['secretRef']).toBeNull();
    expect(await secrets.get(ref)).toBeNull();
  });

  it('updates non-secret fields like name and baseUrl', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Original', kind: 'openai_compatible', baseUrl: 'https://a.example.com' }),
      })
    );

    const patchRes = await app().request(`/api/connections/${created['id']}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', baseUrl: 'https://b.example.com' }),
    });
    const patched = await patchRes.json();
    expect(patched).toMatchObject({ name: 'Renamed', baseUrl: 'https://b.example.com' });
  });

  it('returns 404 when patching an unknown id', async () => {
    const res = await app().request('/api/connections/nope', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/connections/:id', () => {
  it('deletes the connection and its secret', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Delete Me', kind: 'openai', apiKey: 'sk-delete-me' }),
      })
    );
    const id = created['id'] as string;
    const ref = created['secretRef'] as string;

    const delRes = await app().request(`/api/connections/${id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    expect(container.store.connections.get(id)).toBeNull();
    expect(await secrets.get(ref)).toBeNull();
  });
});

describe('POST /api/connections/:id/test', () => {
  it('resolves the apiKey from SecretStore, calls engine.testConnection, and records status on the connection', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Testable', kind: 'openai', apiKey: 'sk-test-key' }),
      })
    );
    const id = created['id'] as string;
    const expected: ConnectionTestResult = { ok: true, message: 'all good', latencyMs: 12 };
    engine.connectionTestResult = expected;

    const res = await app().request(`/api/connections/${id}/test`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expected);
    const updated = container.store.connections.get(id);
    expect(updated?.status).toBe('ok');
    expect(updated?.statusMessage).toBe('all good');
    expect(updated?.checkedAt).not.toBeNull();
  });

  it('never leaks the resolved apiKey in the test response', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Testable', kind: 'openai', apiKey: 'sk-should-not-leak' }),
      })
    );
    const res = await app().request(`/api/connections/${created['id']}/test`, { method: 'POST' });
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('sk-should-not-leak');
  });
});

describe('POST /api/connections/:id/discover-models', () => {
  it('persists discovered models against the connection and returns them', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Discoverable', kind: 'openai', apiKey: 'sk-discover' }),
      })
    );
    const id = created['id'] as string;
    const discovered: DiscoveredModel[] = [
      { modelId: 'gpt-4o', displayName: 'GPT-4o', contextWindow: 128_000, supportsVision: true, supportsTools: true },
    ];
    engine.models = discovered;

    const res = await app().request(`/api/connections/${id}/discover-models`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ modelId: 'gpt-4o', connectionId: id, source: 'discovered' });

    const stored = container.store.models.list(id);
    expect(stored).toHaveLength(1);
  });

  it('re-running discovery updates existing discovered models rather than duplicating them', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Discoverable', kind: 'openai', apiKey: 'sk-discover' }),
      })
    );
    const id = created['id'] as string;
    engine.models = [
      { modelId: 'gpt-4o', displayName: 'GPT-4o (old name)', contextWindow: null, supportsVision: null, supportsTools: null },
    ];
    await app().request(`/api/connections/${id}/discover-models`, { method: 'POST' });

    engine.models = [
      { modelId: 'gpt-4o', displayName: 'GPT-4o (new name)', contextWindow: 200_000, supportsVision: true, supportsTools: true },
    ];
    await app().request(`/api/connections/${id}/discover-models`, { method: 'POST' });

    const stored = container.store.models.list(id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ displayName: 'GPT-4o (new name)', contextWindow: 200_000 });
  });

  it('returns 404 for an unknown connection', async () => {
    const res = await app().request('/api/connections/nope/discover-models', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
