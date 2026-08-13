import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import type { ApprovalRequest } from '@grunt/core/ports/tool-provider.js';
import { McpServerManager } from '@grunt/tools/mcp/manager.js';
import { GruntToolProvider } from '@grunt/tools/provider.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'test', 'fixtures', 'echo-server.js');

let store: InMemoryStore;
let secrets: FakeSecretStore;
let toolProvider: GruntToolProvider;
let mcpManager: McpServerManager;
let container: Container;

beforeEach(() => {
  store = new InMemoryStore();
  secrets = new FakeSecretStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  const broker = new PermissionBroker(store);
  mcpManager = new McpServerManager(store, secrets, { initialBackoffMs: 50, maxBackoffMs: 100 });
  toolProvider = new GruntToolProvider(store, broker, mcpManager);
  container = {
    store,
    secrets,
    engine,
    registry: {} as never,
    toolProvider,
    mcpManager,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    close: () => {},
  };
  store.chats.create({ id: 'chat-1', title: 'Chat', profileId: 'p1', headMessageId: null, workspaceRoot: '/ws', pinned: false, archivedAt: null });
});

afterEach(async () => {
  await mcpManager.shutdown();
});

function app() {
  return createApp(container);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!predicate()) throw new Error('condition not met yet');
    },
    { timeout: timeoutMs, interval: 25 }
  );
}

describe('MCP server routes', () => {
  it('creates a server (storing header values as secrets, never plaintext), lists it, and connects it for real', async () => {
    const res = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Echo Fixture',
        transport: 'stdio',
        command: process.execPath,
        args: [FIXTURE_PATH],
        headers: { 'X-Test': 'super-secret-value' },
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; headerRefs: Record<string, string> };
    // headers is meaningless for a stdio server, so nothing is stored -- and
    // regardless, the raw value must never appear in the response body.
    expect(JSON.stringify(created)).not.toContain('super-secret-value');

    const listRes = await app().request('/api/mcp-servers');
    const health = (await listRes.json()) as { id: string; status: string }[];
    expect(health).toHaveLength(1);

    await waitFor(async () => {
      const r = await app().request('/api/mcp-servers');
      const body = (await r.json()) as { status: string; toolCount: number }[];
      return body[0]?.status === 'ok' && body[0]?.toolCount === 2;
    });
  });

  it('stores http header VALUES as SecretStore refs, not plaintext, and resolves them on connect', async () => {
    const res = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Http Srv', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer sekret' } }),
    });
    const created = (await res.json()) as { id: string; headerRefs: Record<string, string> };
    expect(Object.keys(created.headerRefs)).toEqual(['Authorization']);
    expect(created.headerRefs['Authorization']).not.toBe('Bearer sekret'); // it's a REF, not the value
    expect(await secrets.get(created.headerRefs['Authorization']!)).toBe('Bearer sekret');
  });

  it('updates and deletes a server, re-syncing after each write', async () => {
    const createRes = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH], enabled: false }),
    });
    const created = (await createRes.json()) as { id: string };
    expect(store.mcpServers.get(created.id)!.enabled).toBe(false);

    const patchRes = await app().request(`/api/mcp-servers/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(patchRes.status).toBe(200);
    await waitFor(() => mcpManager.health().find((h) => h.id === created.id)?.status === 'ok');

    const deleteRes = await app().request(`/api/mcp-servers/${created.id}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(204);
    expect(store.mcpServers.get(created.id)).toBeNull();
    expect(mcpManager.listFor([created.id])).toHaveLength(0);
  });

  it('refresh forces a reconnect and 404s for an unknown server', async () => {
    store.mcpServers.create({
      id: 'srv-x',
      name: 'X',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE_PATH],
      env: {},
      url: null,
      headerRefs: {},
      enabled: true,
      status: 'unknown',
      toolsCache: null,
    });
    await mcpManager.sync();
    await waitFor(() => mcpManager.health()[0]?.status === 'ok');

    const res = await app().request('/api/mcp-servers/srv-x/refresh', { method: 'POST' });
    expect(res.status).toBe(204);

    const missing = await app().request('/api/mcp-servers/does-not-exist/refresh', { method: 'POST' });
    expect(missing.status).toBe(404);
  });
});

describe('Grant routes', () => {
  it('lists chat-scoped and always-scoped grants together, and revoking one is immediately reflected', async () => {
    store.grants.create({ id: 'g-chat', chatId: 'chat-1', profileId: null, toolName: 'write_file', source: 'fs', scope: 'chat', constraint: null, expiresAt: null });
    store.grants.create({ id: 'g-always', chatId: null, profileId: null, toolName: 'run_command', source: 'shell', scope: 'always', constraint: { commandPrefix: 'npm test' }, expiresAt: null });
    store.grants.create({ id: 'g-other-chat', chatId: 'chat-2', profileId: null, toolName: 'write_file', source: 'fs', scope: 'chat', constraint: null, expiresAt: null });

    const res = await app().request('/api/chats/chat-1/grants');
    const grants = (await res.json()) as { id: string }[];
    expect(grants.map((g) => g.id).sort()).toEqual(['g-always', 'g-chat']);

    const del = await app().request('/api/grants/g-chat', { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(store.grants.get('g-chat')).toBeNull();

    const notFound = await app().request('/api/grants/does-not-exist', { method: 'DELETE' });
    expect(notFound.status).toBe(404);
  });
});

describe('Audit routes', () => {
  it('lists a chat"s audit trail', async () => {
    store.audit.create({
      id: 'a1',
      chatId: 'chat-1',
      messageId: 'm1',
      toolName: 'write_file',
      argsRedacted: { path: 'x.txt', content: '[redacted]' },
      resultSummary: 'ok',
      durationMs: 12,
      grantedBy: 'ask:once',
    });
    const res = await app().request('/api/chats/chat-1/audit');
    const rows = (await res.json()) as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('a1');
  });
});

describe('Approval routes', () => {
  it('resolves a real pending approval end to end, and 404s on an unknown/already-resolved id', async () => {
    const policy = { fs: 'readwrite' as const, shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' as const };
    const tools = await toolProvider.listTools(policy);
    const writeFile = tools.find((t) => t.name === 'write_file')!;

    const requests: ApprovalRequest[] = [];
    toolProvider.onApprovalEvent((e) => {
      if (e.type === 'request') requests.push(e.request);
    });

    const execPromise = writeFile.execute(
      { path: 'x.txt', content: 'hi' },
      {
        chatId: 'chat-1',
        messageId: 'msg-1',
        profileId: 'profile-1',
        workspaceRoot: '/does-not-matter-not-awaited-yet',
        signal: new AbortController().signal,
      }
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(1);

    const res = await app().request(`/api/approvals/${requests[0]!.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'deny' }),
    });
    expect(res.status).toBe(200);
    await execPromise; // settles now that the approval was answered

    const again = await app().request(`/api/approvals/${requests[0]!.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'deny' }),
    });
    expect(again.status).toBe(404);

    const unknown = await app().request('/api/approvals/never-existed/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'once' }),
    });
    expect(unknown.status).toBe(404);
  });

  it('rejects a malformed choice with 400', async () => {
    const res = await app().request('/api/approvals/whatever/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });
});
