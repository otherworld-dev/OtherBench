import { describe, it, expect, afterEach, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { InMemoryStore, FakeSecretStore } from '@grunt/core/testing/fakes.js';
import type { McpServer } from '@grunt/core/ports/store.js';
import { McpClient } from '../../src/mcp/client.js';
import { McpServerManager } from '../../src/mcp/manager.js';
import { GruntOAuthProvider } from '../../src/mcp/oauth-provider.js';
import { McpOAuthStore } from '../../src/mcp/oauth-store.js';
import { serveHttp } from '../fixtures/echo-server.js';
import { startOAuthEchoServer } from '../fixtures/oauth-echo-server.js';

const ECHO_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'echo-server.js');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function row(over: Partial<McpServer> = {}): McpServer {
  return { id: 'srv-1', name: 'Hosted Docs', transport: 'http', command: null, args: [], envRefs: {}, url: null, headerRefs: {}, enabled: true, status: 'unknown', toolsCache: null, oauth: null, ...over };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  await vi.waitFor(() => {
    if (!predicate()) throw new Error('condition not met yet');
  }, { timeout: timeoutMs, interval: 25 });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function oauthFixture() {
  const fixture = await startOAuthEchoServer();
  cleanups.push(() => fixture.close());
  return fixture;
}

function managerFor(store: InMemoryStore, secrets = new FakeSecretStore()): McpServerManager {
  const manager = new McpServerManager(store, secrets, { initialBackoffMs: 50, maxBackoffMs: 100 });
  cleanups.push(() => manager.shutdown());
  return manager;
}

describe('connections that need sign-in', () => {
  it('a server that answers 401 and holds no sign-in ends in needs_auth, retries nothing and registers nothing', async () => {
    const fixture = await oauthFixture();
    const store = new InMemoryStore();
    store.mcpServers.create(row({ url: fixture.url }));
    const manager = managerFor(store);

    await manager.sync();
    await waitFor(() => manager.health()[0]?.status === 'needs_auth');

    const hits = fixture.mcpRequests();
    await sleep(400); // 8x the 50 ms backoff: a reconnect loop would have hit /mcp again by now
    expect(fixture.mcpRequests()).toBe(hits);
    expect(fixture.registrations).toEqual([]);
    expect(manager.listFor(['srv-1'])).toEqual([]);
    expect(manager.health()[0]).toMatchObject({
      status: 'needs_auth',
      lastError: 'This server needs you to sign in.',
      auth: { state: 'needs_sign_in', account: null, signedInAt: null, pending: false, error: null },
    });
    expect(store.mcpServers.get('srv-1')!.status).toBe('error'); // the persisted column has no needs_auth
  });

  it('a fixed Authorization header (any case) gets no sign-in: a 401 is an ordinary error, retried with backoff', async () => {
    const fixture = await oauthFixture();
    const store = new InMemoryStore();
    const secrets = new FakeSecretStore();
    await secrets.set('ref-auth', 'Bearer not-a-real-token');
    store.mcpServers.create(row({ url: fixture.url, headerRefs: { authorization: 'ref-auth' } }));
    const manager = managerFor(store, secrets);

    await manager.sync();
    await waitFor(() => manager.health()[0]?.status === 'error');
    expect(manager.health()[0]!.auth).toBeNull();
    await waitFor(() => fixture.mcpRequests() >= 3); // still retrying
    expect(fixture.registrations).toEqual([]);
  });

  it('health reports auth null for stdio, and state none for an http server that never asked', async () => {
    const httpServer = await serveHttp(0);
    cleanups.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
    const port = (httpServer.address() as AddressInfo).port;
    const store = new InMemoryStore();
    store.mcpServers.create(row({ id: 'plain', url: `http://127.0.0.1:${port}/mcp` }));
    store.mcpServers.create(row({ id: 'local', transport: 'stdio', command: process.execPath, args: [ECHO_PATH], url: null }));
    const manager = managerFor(store);

    await manager.sync();
    await waitFor(() => manager.health().every((h) => h.status === 'ok'));
    expect(manager.health().find((h) => h.id === 'plain')!.auth).toEqual({ state: 'none', account: null, signedInAt: null, pending: false, error: null });
    expect(manager.health().find((h) => h.id === 'local')!.auth).toBeNull();
  });

  it('restart() reconnects from the current row, picking up a changed URL', async () => {
    const httpServer = await serveHttp(0);
    cleanups.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
    const fixture = await oauthFixture();
    const store = new InMemoryStore();
    store.mcpServers.create(row({ url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp` }));
    const manager = managerFor(store);
    await manager.sync();
    await waitFor(() => manager.health()[0]?.status === 'ok');

    store.mcpServers.update('srv-1', { url: fixture.url });
    await manager.restart('srv-1');
    await waitFor(() => manager.health()[0]?.status === 'needs_auth');
    expect(fixture.mcpRequests()).toBeGreaterThan(0);
  });

  it('callTool on a client that needs sign-in says so', async () => {
    const fixture = await oauthFixture();
    const store = new InMemoryStore();
    store.mcpServers.create(row({ url: fixture.url }));
    const provider = new GruntOAuthProvider('srv-1', new McpOAuthStore(store, new FakeSecretStore()), { kind: 'background' });
    const client = new McpClient('srv-1', { transport: 'http', url: fixture.url, headers: {}, authProvider: provider });
    cleanups.push(() => client.disconnect());

    await client.connect();
    expect(client.status).toBe('needs_auth');
    await expect(client.callTool('echo', { text: 'x' })).rejects.toThrow('This MCP server needs you to sign in again (Settings > MCP servers).');
  });
});
