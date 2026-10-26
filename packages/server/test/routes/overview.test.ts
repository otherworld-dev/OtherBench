import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore, FakeChatEngine, FakeSecretStore } from '@otherbench/core/testing/fakes.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { Overview } from '@otherbench/core/types/overview.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { forwardedApi } from '../../src/peer/forward.js';
import { OverviewError, type OverviewService } from '../../src/overview/service.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const VIEW = { tiles: [], checkedAt: 1 } as unknown as Overview;

interface Calls {
  refresh: number;
  tick: [string, number][];
  older: number[];
}

let container: Container;
let store: InMemoryStore;
let calls: Calls;
let tickFails: OverviewError | null;

beforeEach(() => {
  store = new InMemoryStore('node-pc');
  calls = { refresh: 0, tick: [], older: [] };
  tickFails = null;
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  const overview = {
    view: () => VIEW,
    async refresh() {
      calls.refresh++;
    },
    tickIssue(appId: string, n: number) {
      if (tickFails) throw tickFails;
      calls.tick.push([appId, n]);
      return { appId, number: n, through: 'x' };
    },
    tickOlder(before: number) {
      calls.older.push(before);
      return { chats: 2, issues: 1 };
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

describe('POST /api/overview/issues/:appId/:n/tick', () => {
  it('ticks the issue and returns the overview', async () => {
    const res = await send('POST', '/api/overview/issues/a1/48/tick');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
    expect(calls.tick).toEqual([['a1', 48]]);
  });

  it('is 404 for an unknown app', async () => {
    const res = await send('POST', '/api/overview/issues/nope/48/tick');
    expect(res.status).toBe(404);
    expect(calls.tick).toEqual([]);
  });

  it.each(['abc', '0', '-3', '1.5'])('is 400 for the number %s', async (n) => {
    const res = await send('POST', `/api/overview/issues/a1/${n}/tick`);
    expect(res.status).toBe(400);
    expect(calls.tick).toEqual([]);
  });

  it("is 409 with code 'not-needing' when the issue doesn't need the user", async () => {
    tickFails = new OverviewError('not-needing', "Issue #9 doesn't need you.");
    const res = await send('POST', '/api/overview/issues/a1/9/tick');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Issue #9 doesn't need you.", code: 'not-needing' });
  });
});

describe('POST /api/overview/tick-older', () => {
  it('ticks what is older and returns the counts', async () => {
    const before = Date.now() - 60_000;
    const res = await send('POST', '/api/overview/tick-older', { before });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chats: 2, issues: 1 });
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
    for (const path of ['/overview', '/overview/refresh', '/overview/issues/a1/1/tick']) {
      const res = await api.request(path, {}, { peerNodeId: 'node-laptop' });
      expect(res.status, path).toBe(404);
    }
    const post = await api.request('/overview/tick-older', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"before":1}' }, { peerNodeId: 'node-laptop' });
    expect(post.status).toBe(404);
  });
});
