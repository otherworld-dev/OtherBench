import { describe, it, expect } from 'vitest';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

function makeContainer(): Container {
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  return {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner),
    close: () => {},
  };
}

describe('GET /api/health', () => {
  it('returns a 200 JSON status', async () => {
    const app = createApp(makeContainer());

    const res = await app.request('/api/health');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok' });
  });

  it('is reachable without a token even when the app requires one for other routes', async () => {
    const app = createApp(makeContainer(), { token: 'secret-token' });

    const res = await app.request('/api/health');

    expect(res.status).toBe(200);
  });
});
