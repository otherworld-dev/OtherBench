import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@otherbench/core/testing/fakes.js';
import type { ConnectionTestResult, DiscoveredModel } from '@otherbench/core/ports/chat-engine.js';
import type { Connection } from '@otherbench/core/types/config.js';
import { AiSdkChatEngine } from '@otherbench/engine-aisdk/engine.js';
import { ProviderRegistry } from '@otherbench/engine-aisdk/registry.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

/**
 * Same scriptable behaviour as `FakeChatEngine`, plus the ability to make
 * `listModels` throw -- needed to exercise `discover-models`' error path,
 * which `FakeChatEngine` itself has no hook for (it always resolves with
 * `.models`). Kept local to this test file rather than added to
 * `@otherbench/core`'s shared fakes since that file is out of scope for this fix.
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
  dataDir = await mkdtemp(join(tmpdir(), 'otherbench-connections-route-test-'));
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
  it("closes the engine's processes for the chats that went with it", async () => {
    const created = await json(await app().request('/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Gone', kind: 'openai', apiKey: 'sk-gone' }) }));
    const id = created['id'] as string;
    container.store.profiles.create({ id: 'p-gone', name: 'P', description: null, colour: null, connectionId: id, modelId: 'gpt-4o', systemPrompt: null, params: {}, toolPolicy: { fs: 'none', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' }, isDefault: false, archivedAt: null });
    container.store.chats.create({ id: 'chat-gone', title: 'T', profileId: 'p-gone', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    const closeChats = vi.fn();
    container.engine.closeChats = closeChats;

    expect((await app().request(`/api/connections/${id}`, { method: 'DELETE' })).status).toBe(204);

    expect(closeChats).toHaveBeenCalledTimes(1);
    const gone = closeChats.mock.calls[0]![0] as (chatId: string) => boolean;
    expect(gone('chat-gone')).toBe(true);
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

describe('generation connection kinds', () => {
  async function post(body: Record<string, unknown>): Promise<Response> {
    return app().request('/api/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  it('creates a comfyui connection with a baseUrl', async () => {
    const res = await post({ name: 'Comfy', kind: 'comfyui', baseUrl: 'http://127.0.0.1:8188' });
    expect(res.status).toBe(201);
  });

  it.each(['comfyui', 'a1111', 'openai_images'])('requires a baseUrl for %s', async (kind) => {
    const res = await post({ name: 'Gen', kind });
    expect(res.status).toBe(400);
    expect(String((await json(res))['error'])).toContain('baseUrl');
  });

  it('refuses a user and password in a generation base URL, on create and on PATCH', async () => {
    const res = await post({ name: 'A', kind: 'a1111', baseUrl: 'http://user:pass@127.0.0.1:7860' });
    expect(res.status).toBe(400);
    const message = String((await json(res))['error']);
    expect(message).toContain('API key');
    expect(message).not.toContain('pass@');
    const created = await json(await post({ name: 'A', kind: 'a1111', baseUrl: 'http://127.0.0.1:7860' }));
    const patched = await app().request(`/api/connections/${created['id'] as string}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://admin@127.0.0.1:7860' }),
    });
    expect(patched.status).toBe(400);
    // A chat connection's URL is left as it was.
    expect((await post({ name: 'C', kind: 'openai_compatible', baseUrl: 'http://user:pass@127.0.0.1:1234/v1' })).status).toBe(201);
  });

  it('refuses a PATCH that moves a connection between chat and generation kinds', async () => {
    const gen = await json(await post({ name: 'G', kind: 'comfyui', baseUrl: 'http://127.0.0.1:8188' }));
    const chat = await json(await post({ name: 'C', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1234/v1' }));
    const kind = (id: unknown, k: string) =>
      app().request(`/api/connections/${id as string}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: k }) });
    expect((await kind(gen['id'], 'openai_compatible')).status).toBe(400);
    expect((await kind(chat['id'], 'comfyui')).status).toBe(400);
    // Within a side it is allowed, as before.
    expect((await kind(gen['id'], 'a1111')).status).toBe(200);
    expect((await kind(chat['id'], 'openai')).status).toBe(200);
  });

  it('refuses discover-models for a generation connection', async () => {
    const created = await json(await post({ name: 'Comfy', kind: 'comfyui', baseUrl: 'http://127.0.0.1:8188' }));
    const discover = await app().request(`/api/connections/${created['id'] as string}/discover-models`, { method: 'POST' });
    expect(discover.status).toBe(400);
  });

  describe('against a fake ComfyUI', () => {
    let server: Server | undefined;
    let hits: string[] = [];
    let up = true;
    let history: Record<string, unknown> = {};

    async function startComfy(): Promise<string> {
      hits = [];
      up = true;
      history = {};
      server = createServer((req, res) => {
        hits.push(req.url ?? '');
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (!up) return send(500, { error: 'down' });
        if (req.url === '/system_stats') return send(200, { system: { os: 'nt', comfyui_version: '0.8.2' }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync', vram_total: 25769279488 }] });
        if (req.url?.startsWith('/history')) return send(200, history);
        if (req.url === '/object_info/CheckpointLoaderSimple') return send(200, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd_xl_base_1.0.safetensors', 'juggernaut.safetensors'], {}] } } } });
        if (req.url === '/object_info/UNETLoader') return send(200, { UNETLoader: { input: { required: { unet_name: [['wan2.2_ti2v_5B_fp16.safetensors'], {}] } } } });
        send(404, {});
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    afterEach(async () => {
      server?.closeAllConnections();
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      server = undefined;
    });

    it('Test calls the backend and records the status like a chat test', async () => {
      const baseUrl = await startComfy();
      const id = (await json(await post({ name: 'Comfy', kind: 'comfyui', baseUrl })))['id'] as string;
      const ok = await app().request(`/api/connections/${id}/test`, { method: 'POST' });
      expect(ok.status).toBe(200);
      expect(await json(ok)).toMatchObject({ ok: true, message: 'ComfyUI 0.8.2 · NVIDIA GeForce RTX 3090, 24 GB' });
      expect(hits).toContain('/system_stats');
      expect(container.store.connections.get(id)).toMatchObject({ status: 'ok' });

      up = false;
      const bad = await json(await app().request(`/api/connections/${id}/test`, { method: 'POST' }));
      expect(bad['ok']).toBe(false);
      expect(typeof bad['message']).toBe('string');
      expect(container.store.connections.get(id)).toMatchObject({ status: 'error', statusMessage: bad['message'] });
    });

    it('media-models lists the workflows and the server checkpoints', async () => {
      const baseUrl = await startComfy();
      const id = (await json(await post({ name: 'Comfy', kind: 'comfyui', baseUrl })))['id'] as string;
      const image = await app().request(`/api/connections/${id}/media-models?media=image`);
      expect(image.status).toBe(200);
      expect(await image.json()).toEqual({ models: [{ id: 'builtin:sdxl-txt2img', label: 'SDXL' }], checkpoints: ['sd_xl_base_1.0.safetensors', 'juggernaut.safetensors'] });
      const video = (await (await app().request(`/api/connections/${id}/media-models?media=video`)).json()) as { models: { id: string }[]; checkpoints: string[] };
      expect(video.models.map((m) => m.id)).toEqual(['builtin:wan22-5b-t2v']);
      expect(video.checkpoints).toEqual(['wan2.2_ti2v_5B_fp16.safetensors']);
    });

    it('lists the workflows run from ComfyUI, and says when it has no templates', async () => {
      const baseUrl = await startComfy();
      const graph = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a fox' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } };
      history = {
        mine: { prompt: [1, 'mine', graph, { client_id: 'abc', create_time: 5, extra_pnginfo: { workflow: { nodes: [] } } }, ['2']], outputs: {}, status: {} },
        ours: { prompt: [2, 'ours', graph, { client_id: 'otherbench-1', create_time: 6 }, ['2']], outputs: {}, status: {} },
      };
      const id = (await json(await post({ name: 'Comfy', kind: 'comfyui', baseUrl })))['id'] as string;
      const recent = await app().request(`/api/connections/${id}/comfy/recent`);
      expect(recent.status).toBe(200);
      expect(((await recent.json()) as { promptId: string }[]).map((r) => r.promptId)).toEqual(['mine']);
      const templates = await app().request(`/api/connections/${id}/comfy/templates`);
      expect(templates.status).toBe(200);
      expect(await templates.json()).toEqual({ unsupported: true });
    });

    it('recent and templates are ComfyUI-only, and an unreachable ComfyUI is a 502', async () => {
      const a1111 = (await json(await post({ name: 'A', kind: 'a1111', baseUrl: 'http://127.0.0.1:7860' })))['id'] as string;
      expect((await app().request(`/api/connections/${a1111}/comfy/recent`)).status).toBe(400);
      expect((await app().request(`/api/connections/${a1111}/comfy/templates`)).status).toBe(400);
      expect((await app().request('/api/connections/nope/comfy/recent')).status).toBe(404);
      const baseUrl = await startComfy();
      up = false;
      const id = (await json(await post({ name: 'Comfy', kind: 'comfyui', baseUrl })))['id'] as string;
      const res = await app().request(`/api/connections/${id}/comfy/recent`);
      expect(res.status).toBe(502);
      expect(String((await json(res))['error'])).toMatch(/HTTP 500/);
    });

    it("media-models lists the files of the loader a workflow's model file is on, so a Z-Image image workflow gets UNET files", async () => {
      const baseUrl = await startComfy();
      const id = (await json(await post({ name: 'Comfy', kind: 'comfyui', baseUrl })))['id'] as string;
      const zimage = (await (await app().request(`/api/connections/${id}/media-models?media=image&loader=UNETLoader`)).json()) as { models: { id: string }[]; checkpoints: string[] };
      expect(zimage.models.map((m) => m.id)).toEqual(['builtin:sdxl-txt2img']);
      expect(zimage.checkpoints).toEqual(['wan2.2_ti2v_5B_fp16.safetensors']);
      const sdxlVideo = (await (await app().request(`/api/connections/${id}/media-models?media=video&loader=CheckpointLoaderSimple`)).json()) as { checkpoints: string[] };
      expect(sdxlVideo.checkpoints).toEqual(['sd_xl_base_1.0.safetensors', 'juggernaut.safetensors']);
      const bad = await app().request(`/api/connections/${id}/media-models?media=image&loader=LoadImage`);
      expect(bad.status).toBe(400);
      expect(hits).not.toContain('/object_info/LoadImage');
    });

    it('media-models refuses a bad media and a chat connection', async () => {
      const baseUrl = await startComfy();
      const id = (await json(await post({ name: 'Comfy', kind: 'comfyui', baseUrl })))['id'] as string;
      expect((await app().request(`/api/connections/${id}/media-models?media=audio`)).status).toBe(400);
      const chat = (await json(await post({ name: 'Chat', kind: 'openai', apiKey: 'sk' })))['id'] as string;
      expect((await app().request(`/api/connections/${chat}/media-models?media=image`)).status).toBe(400);
    });

    it('media-models still lists workflows when the checkpoints cannot be read', async () => {
      const baseUrl = await startComfy();
      up = false;
      const id = (await json(await post({ name: 'Comfy', kind: 'comfyui', baseUrl })))['id'] as string;
      const body = (await (await app().request(`/api/connections/${id}/media-models?media=image`)).json()) as Record<string, unknown>;
      expect(body['models']).toEqual([{ id: 'builtin:sdxl-txt2img', label: 'SDXL' }]);
      expect(body['checkpoints']).toEqual([]);
      expect(typeof body['checkpointsError']).toBe('string');
    });
  });
});

describe('POST /api/connections/find-comfyui', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes only the two addresses and creates nothing', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      urls.push(String(input));
      if (String(input).startsWith('http://127.0.0.1:8000/')) {
        return new Response(JSON.stringify({ system: { comfyui_version: '0.8.2' }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync', vram_total: 25769279488 }] }));
      }
      throw new TypeError('fetch failed');
    });
    const res = await app().request('/api/connections/find-comfyui', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ baseUrl: 'http://127.0.0.1:8000', version: '0.8.2', gpu: 'NVIDIA GeForce RTX 3090', vramGb: 24 });
    expect(urls).toEqual(['http://127.0.0.1:8188/system_stats', 'http://127.0.0.1:8000/system_stats']);
    expect(container.store.connections.list()).toEqual([]);
  });

  it('says when neither answers', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    expect(await (await app().request('/api/connections/find-comfyui', { method: 'POST' })).json()).toEqual({ found: false });
  });
});
