import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore, FakeChatEngine, FakeSecretStore } from '@otherbench/core/testing/fakes.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { Overview } from '@otherbench/core/types/overview.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { forwardedApi } from '../../src/peer/forward.js';
import { GhError } from '../../src/code/github.js';
import type { OverviewService } from '../../src/overview/service.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const VIEW = { tiles: [], checkedAt: 1 } as unknown as Overview;

interface Calls {
  refresh: number;
  done: string[];
  read: string[];
  older: number[];
}

let container: Container;
let store: InMemoryStore;
let calls: Calls;
let doneFails: GhError | null;

beforeEach(() => {
  store = new InMemoryStore('node-pc');
  calls = { refresh: 0, done: [], read: [], older: [] };
  doneFails = null;
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  const overview = {
    view: () => VIEW,
    async refresh() {
      calls.refresh++;
    },
    async markDone(id: string) {
      if (doneFails) throw doneFails;
      calls.done.push(id);
    },
    async markRead(id: string) {
      calls.read.push(id);
    },
    tickOlder(before: number) {
      calls.older.push(before);
      return { chats: 2 };
    },
  } as unknown as OverviewService;
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    events: new AppEventBus(),
    overview,
    close: () => {},
  };
  store.apps.create({ id: 'a1', name: 'a1', workspaceRoot: null, githubRepo: 'o/r', defaultProfileId: null });
});

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    createApp(container).request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

describe('GET /api/overview', () => {
  it('returns the overview', async () => {
    const res = await send('GET', '/api/overview');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
  });

  it('is 503 when the server has no overview service', async () => {
    delete container.overview;
    const res = await send('GET', '/api/overview');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});

describe('POST /api/overview/refresh', () => {
  it('refreshes, then returns the overview', async () => {
    const res = await send('POST', '/api/overview/refresh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
    expect(calls.refresh).toBe(1);
  });

  it('is 503 without the service', async () => {
    delete container.overview;
    expect((await send('POST', '/api/overview/refresh')).status).toBe(503);
  });
});

describe('POST /api/overview/notifications/:id/done and /read', () => {
  it('marks it done, or read, and returns the overview', async () => {
    const done = await send('POST', '/api/overview/notifications/123/done');
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual(VIEW);
    const read = await send('POST', '/api/overview/notifications/456/read');
    expect(read.status).toBe(200);
    expect(calls).toMatchObject({ done: ['123'], read: ['456'] });
  });

  it.each(['abc', '12a', '-1'])('is 400 for the id %s, and nothing reaches GitHub', async (id) => {
    for (const action of ['done', 'read']) {
      const res = await send('POST', `/api/overview/notifications/${id}/${action}`);
      expect(res.status).toBe(400);
    }
    expect(calls).toMatchObject({ done: [], read: [] });
  });

  it("answers GitHub's refusal with gh's error code", async () => {
    doneFails = new GhError('gh-signed-out', 'The GitHub CLI is not signed in.');
    const res = await send('POST', '/api/overview/notifications/123/done');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'gh-signed-out' });
  });
});

describe('POST /api/overview/tick-older', () => {
  it('ticks what is older and returns the counts', async () => {
    const before = Date.now() - 60_000;
    const res = await send('POST', '/api/overview/tick-older', { before });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chats: 2 });
    expect(calls.older).toEqual([before]);
  });

  it('clamps a future `before` to now', async () => {
    const t0 = Date.now();
    await send('POST', '/api/overview/tick-older', { before: t0 + 10 * 60_000 });
    expect(calls.older).toHaveLength(1);
    expect(calls.older[0]).toBeGreaterThanOrEqual(t0);
    expect(calls.older[0]).toBeLessThanOrEqual(Date.now());
  });

  it.each([{}, { before: 'soon' }, { before: null }])('is 400 when the body is %j', async (body) => {
    const res = await send('POST', '/api/overview/tick-older', body);
    expect(res.status).toBe(400);
    expect(calls.older).toEqual([]);
  });
});

describe('the peer listener', () => {
  it('has no /overview route', async () => {
    const api = forwardedApi(container);
    for (const path of ['/overview', '/overview/refresh', '/overview/notifications/1/done']) {
      const res = await api.request(path, {}, { peerNodeId: 'node-laptop' });
      expect(res.status, path).toBe(404);
    }
    const post = await api.request('/overview/tick-older', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"before":1}' }, { peerNodeId: 'node-laptop' });
    expect(post.status).toBe(404);
  });
});
