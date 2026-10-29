import { describe, expect, it } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { busyReasons } from '../../src/routes/desktop.js';
import { AppEventBus } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const TOKEN = 't'.repeat(64);

function makeContainer(scheduledRuns = 0): { container: Container; events: AppEventBus } {
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  const events = new AppEventBus();
  const container: Container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    events,
    schedules: { activeRunCount: () => scheduledRuns } as never,
    // An open terminal sitting at a prompt never holds an update back.
    terminals: { list: () => [{ id: 'term-1' }] } as never,
    close: () => {},
  };
  return { container, events };
}

async function busy(container: Container, token: string | null = TOKEN): Promise<Response> {
  const app = createApp(container, { token: TOKEN });
  return app.request('/api/desktop/busy', token ? { headers: { authorization: `Bearer ${token}` } } : {});
}

describe('busyReasons', () => {
  it('says nothing when nothing runs', () => {
    expect(busyReasons({ runningTurns: 0, scheduledRuns: 0, backgroundTasks: 0 })).toEqual([]);
  });

  it('counts replies, scheduled runs and background tasks', () => {
    expect(busyReasons({ runningTurns: 1, scheduledRuns: 0, backgroundTasks: 0 })).toEqual(['1 reply being written']);
    expect(busyReasons({ runningTurns: 3, scheduledRuns: 2, backgroundTasks: 0 })).toEqual(['3 replies being written', '2 scheduled runs']);
    expect(busyReasons({ runningTurns: 0, scheduledRuns: 1, backgroundTasks: 0 })).toEqual(['1 scheduled run']);
    expect(busyReasons({ runningTurns: 0, scheduledRuns: 0, backgroundTasks: 2 })).toEqual(['2 background tasks']);
  });
});

describe('GET /api/desktop/busy', () => {
  it('is not busy with nothing running, even with a terminal open', async () => {
    const res = await busy(makeContainer().container);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ busy: false, reasons: [] });
  });

  it('a reply being written makes it busy and says so', async () => {
    const { container, events } = makeContainer();
    events.emit({ type: 'turn-started', chatId: 'chat-1', messageIds: ['m-1'] } as never);
    expect(await (await busy(container)).json()).toEqual({ busy: true, reasons: ['1 reply being written'] });
  });

  it("a Claude Code agent's background tasks make it busy between replies", async () => {
    const { container, events } = makeContainer();
    events.emit({ type: 'background-tasks', chatId: 'chat-1', count: 1 } as never);
    expect(await (await busy(container)).json()).toEqual({ busy: true, reasons: ['1 background task'] });
  });

  it('a scheduled run makes it busy', async () => {
    expect(await (await busy(makeContainer(1).container)).json()).toEqual({ busy: true, reasons: ['1 scheduled run'] });
  });

  it('needs the token', async () => {
    expect((await busy(makeContainer().container, null)).status).toBe(401);
  });
});
