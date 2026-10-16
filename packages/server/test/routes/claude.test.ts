import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@otherbench/core/testing/fakes.js';
import type { Connection } from '@otherbench/core/types/config.js';
import type { PlanUsage } from '@otherbench/core/types/usage.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const usage: PlanUsage = { fetchedAt: 5, windows: [{ id: 'seven_day', label: 'Weekly', percent: 80, resetsAt: null }] };

let container: Container;
let planUsage: ReturnType<typeof vi.fn<(conn: Connection) => Promise<PlanUsage | null>>>;

beforeEach(() => {
  const store = new InMemoryStore();
  planUsage = vi.fn(async () => usage);
  const engine = Object.assign(new FakeChatEngine([]), { planUsage });
  const turnRunner = new TurnRunner(store, engine);
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
    close: () => {},
  };
});

function connection(id: string, kind: Connection['kind'], baseUrl: string | null = null): void {
  container.store.connections.create({ id, name: id, kind, baseUrl, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
}

describe('GET /api/claude/plan-usage', () => {
  it('reads it through a Claude Code connection that uses the Claude login, and serves the reading again', async () => {
    connection('ollama-cc', 'claude_code', 'http://localhost:11434');
    connection('mock', 'mock');
    connection('cc', 'claude_code');
    const app = createApp(container);

    const res = await app.request('/api/claude/plan-usage');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ usage });
    expect(planUsage).toHaveBeenCalledTimes(1);
    expect(planUsage.mock.calls[0]![0].id).toBe('cc');

    // Within 30 s even a refresh is served from the last reading.
    expect(await (await app.request('/api/claude/plan-usage?refresh=1')).json()).toEqual({ usage });
    expect(planUsage).toHaveBeenCalledTimes(1);
  });

  it('is null, without asking the engine, when no connection uses the Claude login', async () => {
    connection('ollama-cc', 'claude_code', 'http://localhost:11434');
    const res = await createApp(container).request('/api/claude/plan-usage');
    expect(await res.json()).toEqual({ usage: null });
    expect(planUsage).not.toHaveBeenCalled();
  });
});
