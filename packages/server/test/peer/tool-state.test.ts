import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Grant } from '@otherbench/core/ports/store.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { createApp } from '../../src/app.js';
import { createContainer, type Container } from '../../src/container.js';
import { toolStateOf } from '../../src/peer/service.js';

interface Machine {
  id: string;
  container: Container;
  events: AppEvent[];
  api: (method: string, path: string, body?: unknown) => Promise<Response>;
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
});

async function machine(name: string): Promise<Machine> {
  const dir = mkdtempSync(join(tmpdir(), `otherbench-tool-state-${name}-`));
  const container = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json'), peerPort: 0, peerHosts: ['127.0.0.1'] });
  container.store.nodes.rename(name);
  const app = createApp(container);
  const events: AppEvent[] = [];
  const unsubscribe = container.events!.subscribe((e) => events.push(e));
  cleanup.push(() => {
    unsubscribe();
    container.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    id: container.store.nodes.self().id,
    container,
    events,
    api: async (method, path, body) => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  };
}

const grant = (id: string, chatId: string | null, profileId: string | null = null): Grant => ({
  id, chatId, profileId, toolName: 'run_command', source: 'shell', scope: chatId === null ? 'always' : 'chat', constraint: { commandExact: 'npm test' }, expiresAt: null,
});

/** The PC has a chat that runs on it, and an MCP server of its own; the laptop has a different server, and has synced the chat. */
async function setup(): Promise<{ pc: Machine; laptop: Machine; chatId: string; profileId: string }> {
  const pc = await machine('PC');
  const laptop = await machine('Laptop');
  const view = await pc.container.peers!.startPairing();
  await laptop.container.peers!.pairWith(view.addresses[0]!, view.code);
  await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');

  const connection = (await (await pc.api('POST', '/api/connections', { name: 'Mock', kind: 'mock', availability: 'anywhere' })).json()) as { id: string };
  const profile = (await (
    await pc.api('POST', '/api/profiles', { name: 'Reader', connectionId: connection.id, modelId: 'mock', toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' } })
  ).json()) as { id: string };
  const chat = (await (await pc.api('POST', '/api/chats', { profileId: profile.id })).json()) as { id: string };
  // Disabled, so nothing is started: only their names and health are listed.
  expect((await pc.api('POST', '/api/mcp-servers', { name: 'PC tools', transport: 'stdio', command: 'pc-only-mcp', enabled: false })).status).toBe(201);
  expect((await laptop.api('POST', '/api/mcp-servers', { name: 'Laptop tools', transport: 'stdio', command: 'laptop-only-mcp', enabled: false })).status).toBe(201);

  await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
  expect(laptop.container.store.chats.get(chat.id)?.runsOn).toBe(pc.id);
  return { pc, laptop, chatId: chat.id, profileId: profile.id };
}

describe("the Inspector's tool state for a chat that runs on another machine", () => {
  it("shows that machine's MCP servers, grants and audit trail, not this one's", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    pc.container.store.grants.create(grant('g-chat', chatId));
    pc.container.store.grants.create(grant('g-always', null, profileId));
    laptop.container.store.grants.create(grant('g-laptop', null));
    pc.container.store.messages.create({ id: 'm1', chatId, parentId: null, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null });
    pc.container.store.audit.create({ id: 'a1', chatId, messageId: 'm1', toolName: 'read_file', argsRedacted: {}, resultSummary: 'read 3 lines', durationMs: 4, grantedBy: 'auto_read' });

    const servers = (await (await laptop.api('GET', `/api/chats/${chatId}/mcp-servers`)).json()) as { name: string }[];
    expect(servers.map((s) => s.name)).toEqual(['PC tools']);
    const grants = (await (await laptop.api('GET', `/api/chats/${chatId}/grants`)).json()) as Grant[];
    expect(grants.map((g) => g.id).sort()).toEqual(['g-always', 'g-chat']);
    const audit = (await (await laptop.api('GET', `/api/chats/${chatId}/audit`)).json()) as { id: string }[];
    expect(audit.map((a) => a.id)).toEqual(['a1']);

    // This machine's own list is still its own.
    expect(((await (await laptop.api('GET', '/api/mcp-servers')).json()) as { name: string }[]).map((s) => s.name)).toEqual(['Laptop tools']);
  });

  it("follows the chat: run here, it shows this machine's again", async () => {
    const { laptop, chatId } = await setup();
    expect((await laptop.api('PATCH', `/api/chats/${chatId}`, { runsOn: laptop.id })).status).toBe(200);
    const servers = (await (await laptop.api('GET', `/api/chats/${chatId}/mcp-servers`)).json()) as { name: string }[];
    expect(servers.map((s) => s.name)).toEqual(['Laptop tools']);
  });

  it("revokes a grant there, but only one the chat lists", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const other = (await (await pc.api('POST', '/api/chats', { profileId })).json()) as { id: string };
    pc.container.store.grants.create(grant('g-chat', chatId));
    pc.container.store.grants.create(grant('g-other', other.id));
    expect((await laptop.api('DELETE', `/api/chats/${chatId}/grants/g-other`)).status).toBe(404);
    expect(pc.container.store.grants.get('g-other')).not.toBeNull();
    expect((await laptop.api('DELETE', `/api/chats/${chatId}/grants/g-chat`)).status).toBe(204);
    expect(pc.container.store.grants.get('g-chat')).toBeNull();
  });

  it('reconnects an MCP server there', async () => {
    const { pc, laptop, chatId } = await setup();
    const [server] = pc.container.store.mcpServers.list();
    expect((await laptop.api('POST', `/api/chats/${chatId}/mcp-servers/${server!.id}/refresh`)).status).toBe(204);
    expect((await laptop.api('POST', `/api/chats/${chatId}/mcp-servers/no-such-server/refresh`)).status).toBe(404);
  });

  it("is refused for a chat that doesn't run on the machine asked", async () => {
    const { pc, laptop, chatId } = await setup();
    pc.container.store.grants.create(grant('g-chat', chatId));
    // The laptop is asked, over the peer listener, for a chat that runs on the PC.
    for (const path of [`/api/chats/${chatId}/grants`, `/api/chats/${chatId}/mcp-servers`, `/api/chats/${chatId}/audit`]) {
      expect((await pc.container.peers!.call(laptop.id, { method: 'GET', path })).status).toBe(409);
    }
    expect((await pc.container.peers!.call(laptop.id, { method: 'DELETE', path: `/api/chats/${chatId}/grants/g-chat` })).status).toBe(409);
  });

  it("tells this machine when that machine's grants, audit trail or MCP health change", async () => {
    const { pc, laptop, chatId } = await setup();
    const told = (): AppEvent[] => laptop.events.filter((e) => e.type === 'peer-tool-state');
    pc.container.store.grants.create(grant('g-chat', chatId));
    await expect.poll(() => told()).toContainEqual({ type: 'peer-tool-state', nodeId: pc.id, section: 'grants', chatId });
    pc.container.store.messages.create({ id: 'm1', chatId, parentId: null, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null });
    pc.container.store.audit.create({ id: 'a1', chatId, messageId: 'm1', toolName: 'read_file', argsRedacted: {}, resultSummary: 'x', durationMs: 1, grantedBy: 'auto_read' });
    await expect.poll(() => told()).toContainEqual({ type: 'peer-tool-state', nodeId: pc.id, section: 'audit', chatId });
    expect((await pc.api('PATCH', `/api/mcp-servers/${pc.container.store.mcpServers.list()[0]!.id}`, { name: 'Renamed' })).status).toBe(200);
    await expect.poll(() => told()).toContainEqual({ type: 'peer-tool-state', nodeId: pc.id, section: 'mcp', chatId: null });
  });
});

describe('toolStateOf', () => {
  it('keeps a known section with a chat id or null, and nothing else', () => {
    expect(toolStateOf({ section: 'grants', chatId: 'c1', extra: 'dropped' })).toEqual({ section: 'grants', chatId: 'c1' });
    expect(toolStateOf({ section: 'mcp', chatId: null })).toEqual({ section: 'mcp', chatId: null });
    for (const bad of [null, 'grants', { section: 'secrets', chatId: null }, { section: 'audit' }, { section: 'audit', chatId: 3 }, { section: 'audit', chatId: 'x'.repeat(500) }]) {
      expect(toolStateOf(bad)).toBeNull();
    }
  });
});
