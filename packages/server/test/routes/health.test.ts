import { describe, it, expect } from 'vitest';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';

function makeContainer(): Container {
  return {
    store: new InMemoryStore(),
    secrets: new FakeSecretStore(),
    engine: new FakeChatEngine([]),
    registry: {} as never,
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
