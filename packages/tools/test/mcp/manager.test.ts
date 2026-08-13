import { describe, it, expect, afterEach, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import { FakeSecretStore } from '@grunt/core/testing/fakes.js';
import type { McpServer } from '@grunt/core/ports/store.js';
import { McpServerManager } from '../../src/mcp/manager.js';

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'echo-server.js');

function makeRow(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'srv-1',
    name: 'Echo Fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE_PATH],
    env: {},
    url: null,
    headerRefs: {},
    enabled: true,
    status: 'unknown',
    toolsCache: null,
    ...overrides,
  };
}

const managers: McpServerManager[] = [];
afterEach(async () => {
  while (managers.length > 0) {
    await managers.pop()!.shutdown();
  }
});

function makeManager(store: InMemoryStore): McpServerManager {
  const manager = new McpServerManager(store, new FakeSecretStore(), { initialBackoffMs: 50, maxBackoffMs: 100 });
  managers.push(manager);
  return manager;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error('condition not met yet');
    },
    { timeout: timeoutMs, interval: 25 }
  );
}

describe('McpServerManager', () => {
  it('connects an enabled server on sync(), and health()/listFor() reflect the real connection', async () => {
    const store = new InMemoryStore();
    store.mcpServers.create(makeRow());
    const manager = makeManager(store);

    await manager.sync();
    await waitFor(() => manager.health()[0]?.status === 'ok');

    const health = manager.health();
    expect(health).toEqual([expect.objectContaining({ id: 'srv-1', name: 'Echo Fixture', status: 'ok', toolCount: 2 })]);

    const listed = manager.listFor(['srv-1']);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.client.tools.map((t) => t.name).sort()).toEqual(['crash', 'echo']);

    // The connection's live status is also persisted back to the store row (task 25/26 brief: "surface status").
    expect(store.mcpServers.get('srv-1')!.status).toBe('ok');
    expect(store.mcpServers.get('srv-1')!.toolsCache).toBeTruthy();
  });

  it('does not connect a disabled server, and disconnects one that becomes disabled after a later sync()', async () => {
    const store = new InMemoryStore();
    store.mcpServers.create(makeRow({ enabled: false }));
    const manager = makeManager(store);

    await manager.sync();
    expect(manager.listFor(['srv-1'])).toHaveLength(0);
    expect(manager.health()[0]!.status).toBe('unknown');

    store.mcpServers.update('srv-1', { enabled: true });
    await manager.sync();
    await waitFor(() => manager.health()[0]?.status === 'ok');
    expect(manager.listFor(['srv-1'])).toHaveLength(1);

    store.mcpServers.update('srv-1', { enabled: false });
    await manager.sync();
    expect(manager.listFor(['srv-1'])).toHaveLength(0);
  });

  it('refresh() forces a reconnect for one server without touching others', async () => {
    const store = new InMemoryStore();
    store.mcpServers.create(makeRow({ id: 'srv-1', name: 'A' }));
    store.mcpServers.create(makeRow({ id: 'srv-2', name: 'B' }));
    const manager = makeManager(store);

    await manager.sync();
    await waitFor(() => manager.health().every((h) => h.status === 'ok'));

    await manager.refresh('srv-1');
    expect(manager.health().find((h) => h.id === 'srv-1')!.status).toBe('ok');
    expect(manager.health().find((h) => h.id === 'srv-2')!.status).toBe('ok');
  });

  it('a misconfigured row (stdio with no command) is marked error and never crashes sync()', async () => {
    const store = new InMemoryStore();
    store.mcpServers.create(makeRow({ command: null }));
    const manager = makeManager(store);

    await expect(manager.sync()).resolves.not.toThrow();
    expect(store.mcpServers.get('srv-1')!.status).toBe('error');
    expect(manager.listFor(['srv-1'])).toHaveLength(0);
  });
});
