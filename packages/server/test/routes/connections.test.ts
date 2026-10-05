import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import type { ConnectionTestResult, DiscoveredModel } from '@grunt/core/ports/chat-engine.js';
import type { Connection } from '@grunt/core/types/config.js';
import { AiSdkChatEngine } from '@grunt/engine-aisdk/engine.js';
import { ProviderRegistry } from '@grunt/engine-aisdk/registry.js';
import { createBlobStore } from '@grunt/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

/**
 * Same scriptable behaviour as `FakeChatEngine`, plus the ability to make
 * `listModels` throw -- needed to exercise `discover-models`' error path,
 * which `FakeChatEngine` itself has no hook for (it always resolves with
 * `.models`). Kept local to this test file rather than added to
 * `@grunt/core`'s shared fakes since that file is out of scope for this fix.
 */
class ThrowingModelsEngine extends FakeChatEngine {
  listModelsError: unknown = null;

  override async listModels(conn: Connection, apiKey: string | null): Promise<DiscoveredModel[]> {
    if (this.listModelsError) throw this.listModelsError;
    return super.listModels(conn, apiKey);
  }
}

/** Shaped like the real `APICallError` (`@ai-sdk/provider`) that `AiSdkChatEngine.listRealModels` throws on a non-2xx response -- `classifyProviderError` duck-types on exactly these fields (see packages/core/src/types/errors.ts). */
function fakeAuthError(): Error {
  const err = new Error('Request failed with status 401.') as Error & {
    statusCode: number;
    isRetryable: boolean;
    responseBody: string;
  };
  err.name = 'AI_APICallError';
  err.statusCode = 401;
  err.isRetryable = false;
  err.responseBody = '{"error":{"message":"Invalid API key provided."}}';
  return err;
}

/** Shaped like a raw `fetch` network failure (DNS/connection-refused/etc.) -- no AI SDK name marker, classified by `classifyProviderError`'s network-pattern fallback. */
function fakeNetworkError(): TypeError {
  const err = new TypeError('fetch failed');
  (err as unknown as { cause: unknown }).cause = { code: 'ECONNREFUSED' };
  return err;
}

let container: Container;
let secrets: FakeSecretStore;
let engine: ThrowingModelsEngine;
let dataDir: string;

// A REAL, temp-dir-backed BlobStore -- see chats.test.ts's identical
// comment for why a `{} as never` placeholder is no longer safe to use
// here: DELETE /api/connections/:id now runs the real blob-GC sweep, and a
// mis-wired blobStore would 500 every DELETE test instead of exercising
// anything real (task 32 fix round 1, Minor #8).
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'grunt-connections-route-test-'));
  secrets = new FakeSecretStore();
  engine = new ThrowingModelsEngine([]);
  const store = new InMemoryStore();
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store,
    secrets,
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(dataDir, 'attachments')),
    close: () => {},
  };
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
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

describe('where a connection can be used (v2 spec §5)', () => {
  async function create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await app().request('/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(201);
    return json(res);
  }

  it('binds a loopback connection to this machine, leaves a cloud one anywhere, and takes an explicit choice', async () => {
    const self = container.store.nodes.self().id;
    expect(await create({ name: 'Ollama', kind: 'ollama' })).toMatchObject({ availability: self, syncSecret: true });
    expect(await create({ name: 'LM Studio', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1234/v1' })).toMatchObject({ availability: self });
    expect(await create({ name: 'Anthropic', kind: 'anthropic' })).toMatchObject({ availability: 'anywhere' });
    expect(await create({ name: 'Shared Ollama', kind: 'ollama', availability: 'anywhere', syncSecret: false })).toMatchObject({ availability: 'anywhere', syncSecret: false });
    const bad = await app().request('/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'X', kind: 'anthropic', availability: 'node-unknown' }) });
    expect(bad.status).toBe(400);
  });

  it('follows a new address unless told otherwise', async () => {
    const created = await create({ name: 'Compat', kind: 'openai_compatible', baseUrl: 'https://api.example.com/v1' });
    const patched = await app().request(`/api/connections/${created['id'] as string}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: 'http://localhost:8080/v1' }) });
    expect(await json(patched)).toMatchObject({ availability: container.store.nodes.self().id });
  });

  it("refuses to run a profile whose connection only works on another machine", async () => {
    container.store.peers.create({ nodeId: 'node-pc', name: 'PC', fingerprint: 'f'.repeat(64), addresses: [], issuedTokenHash: 'h', heldTokenRef: 'r', platform: 'win32', lastSeenAt: null, lastSyncSeq: 0, pairedAt: 1 });
    const conn = await create({ name: 'PC Ollama', kind: 'ollama', availability: 'node-pc' });
    container.store.profiles.create({
      id: 'p-pc', name: 'Local Llama', description: null, colour: null, connectionId: conn['id'] as string, modelId: 'llama', systemPrompt: null, params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null,
    });
    container.store.chats.create({ id: 'c', title: 'T', profileId: 'p-pc', headMessageId: null, workspace: null, pinned: false, archivedAt: null });

    const res = await app().request('/api/chats/c/turns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }], profileIds: ['p-pc'] }) });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('only works on PC');
    expect(container.store.messages.roots('c')).toEqual([]);
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

  it('rejects clearing baseUrl on an existing openai_compatible connection with 400', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Local LLM', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8080/v1' }),
      })
    );
    const res = await app().request(`/api/connections/${created['id']}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: null }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects switching kind to openai_compatible without also supplying a baseUrl', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Was OpenAI', kind: 'openai', apiKey: 'sk-x' }),
      })
    );
    const res = await app().request(`/api/connections/${created['id']}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'openai_compatible' }),
    });
    expect(res.status).toBe(400);
  });

  it('does not force a legacy invalid row (openai_compatible, no baseUrl) to fix baseUrl just to rename it', async () => {
    // Simulates a row saved before creation-time validation existed --
    // inserted directly into the store, bypassing POST's check.
    const id = randomUUID();
    container.store.connections.create({
      id,
      name: 'Legacy Local LLM',
      kind: 'openai_compatible',
      baseUrl: null,
      secretRef: null,
      extraHeaders: {},
      status: 'unknown',
      statusMessage: null,
      checkedAt: null,
    });

    const res = await app().request(`/api/connections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Legacy LLM' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res))['name']).toBe('Renamed Legacy LLM');
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

  it(
    'returns a classified, non-500 error (not a stack trace) testing an openai_compatible connection with no baseUrl -- ' +
      'against the REAL AiSdkChatEngine/ProviderRegistry, reproducing the reported opaque-500 bug end to end',
    async () => {
      // FakeChatEngine (used by every other test in this file) never calls a
      // resolver at all, so it cannot see this bug -- it only exists on the
      // path through the real ProviderRegistry.resolve() -> buildProvider(),
      // which throws ConfigError synchronously for an openai_compatible
      // connection with no baseUrl (registry.ts). A row in exactly this state
      // is inserted directly into the store rather than via POST, standing in
      // for a connection created before any creation-time validation existed
      // -- proving the fix protects existing rows, not just newly rejected
      // ones.
      const realContainer: Container = { ...container, engine: new AiSdkChatEngine(new ProviderRegistry()) };
      const id = randomUUID();
      container.store.connections.create({
        id,
        name: 'Legacy Local LLM',
        kind: 'openai_compatible',
        baseUrl: null,
        secretRef: null,
        extraHeaders: {},
        status: 'unknown',
        statusMessage: null,
        checkedAt: null,
      });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await createApp(realContainer).request(`/api/connections/${id}/test`, { method: 'POST' });

      expect(res.status).not.toBe(500);
      const body = await json(res);
      expect(JSON.stringify(body)).not.toBe('{"error":"Internal server error."}');
      // The generic catch-all in app.ts's onError (console.error + {error:
      // 'Internal server error.'}) must never fire -- proves the failure was
      // classified rather than falling through as an unhandled rejection.
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    }
  );
});

describe('POST /api/connections validates openai_compatible requires a baseUrl', () => {
  it('rejects creating an openai_compatible connection with no baseUrl with 400', async () => {
    const res = await app().request('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Base URL', kind: 'openai_compatible' }),
    });
    expect(res.status).toBe(400);
    expect(container.store.connections.list()).toHaveLength(0);
  });

  it('still allows an openai_compatible connection when baseUrl is provided', async () => {
    const res = await app().request('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Local LLM', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8080/v1' }),
    });
    expect(res.status).toBe(201);
  });

  it('does not require a baseUrl for other connection kinds', async () => {
    const res = await app().request('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Local Ollama', kind: 'ollama' }),
    });
    expect(res.status).toBe(201);
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

  it('returns a classified, non-500 error (not a stack trace) when discovery fails on a bad API key', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bad Key', kind: 'openai', apiKey: 'sk-wrong' }),
      })
    );
    const id = created['id'] as string;
    engine.listModelsError = fakeAuthError();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app().request(`/api/connections/${id}/discover-models`, { method: 'POST' });

    expect(res.status).not.toBe(500);
    const body = await json(res);
    expect(body).toMatchObject({ kind: 'auth', retryable: false });
    expect(typeof body['message']).toBe('string');
    expect((body['message'] as string).length).toBeGreaterThan(0);
    // The generic catch-all in app.ts's onError (console.error + {error:
    // 'Internal server error.'}) must never fire for this -- proves the
    // route classified the failure itself rather than letting it fall
    // through.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toBe('{"error":"Internal server error."}');

    // Nothing should have been persisted -- discovery produced no models.
    expect(container.store.models.list(id)).toHaveLength(0);

    consoleErrorSpy.mockRestore();
  });

  it(
    'a hand-edited capability flag survives a re-run of discovery, even when the provider reports the same ' +
      'definite (non-null) values it always did -- Finding 3 regression: upsertDiscoveredModels used to rely on ' +
      '`d.supportsTools ?? current.supportsTools`, which only protected an edit while discovery returned null; ' +
      'Ollama-style discovery reporting definite true/false clobbered it right back',
    async () => {
      const created = await json(
        await app().request('/api/connections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Ollama box', kind: 'ollama' }),
        })
      );
      const id = created['id'] as string;
      engine.models = [
        { modelId: 'qwen2.5-coder:3b-base', displayName: 'qwen2.5-coder:3b-base', contextWindow: 32768, supportsVision: false, supportsTools: false },
      ];

      const firstRes = await app().request(`/api/connections/${id}/discover-models`, { method: 'POST' });
      const [discovered] = (await firstRes.json()) as Array<Record<string, unknown>>;
      expect(discovered).toMatchObject({ source: 'discovered', supportsTools: false, supportsVision: false });

      // The user hand-edits capabilities in the Models panel.
      const patched = await json(
        await app().request(`/api/models/${discovered!['id']}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ supportsTools: true, supportsVision: true, contextWindow: 4096 }),
        })
      );
      expect(patched).toMatchObject({ source: 'manual', supportsTools: true, supportsVision: true, contextWindow: 4096 });

      // Re-discovery reports the exact same provider values as before (not
      // null -- the whole point of the bug this reproduces).
      engine.models = [
        { modelId: 'qwen2.5-coder:3b-base', displayName: 'qwen2.5-coder:3b-base', contextWindow: 32768, supportsVision: false, supportsTools: false },
      ];
      const secondRes = await app().request(`/api/connections/${id}/discover-models`, { method: 'POST' });
      const [afterRediscover] = (await secondRes.json()) as Array<Record<string, unknown>>;

      expect(afterRediscover).toMatchObject({ source: 'manual', supportsTools: true, supportsVision: true, contextWindow: 4096 });
    }
  );

  it('returns a classified, retryable error when discovery fails on a network/transient error', async () => {
    const created = await json(
      await app().request('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Unreachable', kind: 'openai_compatible', baseUrl: 'https://unreachable.example.com' }),
      })
    );
    const id = created['id'] as string;
    engine.listModelsError = fakeNetworkError();

    const res = await app().request(`/api/connections/${id}/discover-models`, { method: 'POST' });

    expect(res.status).not.toBe(500);
    const body = await json(res);
    expect(body).toMatchObject({ kind: 'transient', retryable: true });
    expect(typeof body['message']).toBe('string');
  });
});
