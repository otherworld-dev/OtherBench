import { describe, it, expect } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import { createApp } from '../src/app.js';
import type { Container } from '../src/container.js';
import { StreamRegistry } from '../src/stream/registry.js';

function makeContainer(): Container {
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  return {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    close: () => {},
  };
}

describe('createApp auth gate', () => {
  it('allows API requests through with no token configured (loopback-only serving)', async () => {
    const app = createApp(makeContainer());

    const res = await app.request('/api/connections');

    expect(res.status).toBe(200);
  });

  it('rejects API requests with no Authorization header when a token is configured', async () => {
    const app = createApp(makeContainer(), { token: 'secret-token' });

    const res = await app.request('/api/connections');

    expect(res.status).toBe(401);
  });

  it('rejects API requests with the wrong bearer token', async () => {
    const app = createApp(makeContainer(), { token: 'secret-token' });

    const res = await app.request('/api/connections', { headers: { Authorization: 'Bearer wrong-token' } });

    expect(res.status).toBe(401);
  });

  it('allows API requests with the correct bearer token', async () => {
    const app = createApp(makeContainer(), { token: 'secret-token' });

    const res = await app.request('/api/connections', { headers: { Authorization: 'Bearer secret-token' } });

    expect(res.status).toBe(200);
  });

  it('returns a 404 JSON body (not a crash) for an unknown route', async () => {
    const app = createApp(makeContainer());

    const res = await app.request('/api/nonexistent');

    expect(res.status).toBe(404);
  });
});

describe('createApp onError', () => {
  // Regression: HTTPException's own default getResponse() returns the
  // message as a bare text/plain body, which extractErrorMessage
  // (packages/web/src/state/api.ts) cannot parse as JSON -- it falls back
  // to res.statusText (empty for a manually-built Response), so every
  // validator's carefully-written message was silently replaced with a bare
  // "HTTP 400" client-side. This must come back as {error: <message>} JSON,
  // exactly like the 500 catch-all already does, for any of it to actually
  // reach a user.
  it('wraps a validator-thrown HTTPException as {error: <message>} JSON, not a bare text/plain body', async () => {
    const app = createApp(makeContainer());

    const res = await app.request('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'anthropic' }), // missing required "name"
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/"name" is required/i);
  });
});
