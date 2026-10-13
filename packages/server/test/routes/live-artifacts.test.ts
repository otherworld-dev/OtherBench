import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import { McpServerManager } from '@grunt/tools/mcp/manager.js';
import { GruntToolProvider } from '@grunt/tools/provider.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

/** Live artifacts (spec 2026-10-12-live-artifacts): the routes, with the real fixture server over stdio. */
const LIVE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'test', 'fixtures', 'live-server.js');
const LIVE = { calls: [{ id: 'value', tool: 'mcp__Live__lookup', args: { key: { $param: 'key' } }, params: { key: { enum: ['a', 'b'], default: 'a' } } }] };
const BASE = '/api/chats/c1/artifacts/art/versions/v1/live';

let store: InMemoryStore;
let manager: McpServerManager;
let container: Container;

beforeEach(async () => {
  store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  manager = new McpServerManager(store, new FakeSecretStore(), { initialBackoffMs: 50, maxBackoffMs: 100 });
  const toolProvider = new GruntToolProvider(store, new PermissionBroker(store), manager);
  container = {
    store, secrets: new FakeSecretStore(), engine, registry: {} as never, toolProvider, mcpManager: manager,
    turnRunner, streamRegistry: new StreamRegistry(turnRunner, store), blobStore: {} as never, close: () => {},
  };
  store.mcpServers.create({ id: 'srv-live', name: 'Live', transport: 'stdio', command: process.execPath, args: [LIVE_FIXTURE], envRefs: {}, url: null, headerRefs: {}, enabled: true, status: 'unknown', toolsCache: null, oauth: null });
  store.profiles.create({ id: 'p1', name: 'Live profile', description: null, colour: null, connectionId: 'conn', modelId: 'm', systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: ['srv-live'], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null });
  store.chats.create({ id: 'c1', title: 'C', profileId: 'p1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  const msg = (id: string, parentId: string | null, role: 'user' | 'assistant') =>
    store.messages.create({ id, chatId: 'c1', parentId, role, parts: [], status: 'complete', error: null, producedBy: null });
  msg('u1', null, 'user');
  msg('a1', 'u1', 'assistant');
  store.chats.update('c1', { headMessageId: 'a1' });
  store.artifacts.create({ id: 'art', chatId: 'c1', slug: 'dash', kind: 'html', language: null, createdAt: 1 });
  store.artifacts.addVersion({ id: 'v1', artifactId: 'art', title: 'Dash', content: '<p></p>', madeBy: 'model', messageId: 'a1', parentVersionId: null, createdAt: 2, live: LIVE });
  store.artifacts.addVersion({ id: 'v-plain', artifactId: 'art', title: 'Dash', content: '<p></p>', madeBy: 'model', messageId: 'a1', parentVersionId: 'v1', createdAt: 3 });
  store.artifacts.addVersion({ id: 'v-orphan', artifactId: 'art', title: 'Dash', content: '<p></p>', madeBy: 'model', messageId: 'reply-not-synced-yet', parentVersionId: 'v1', createdAt: 4, live: LIVE });
  await manager.sync();
  await vi.waitFor(
    () => {
      if (manager.listFor(['srv-live']).length !== 1) throw new Error('not connected yet');
    },
    { timeout: 5000, interval: 25 }
  );
});

afterEach(async () => {
  await manager.shutdown();
});

const app = () => createApp(container);
const send = (method: string, path: string, body: unknown) => app().request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe('live artifact routes', () => {
  it('lists the calls with their state, args and params, the machine and the profile', async () => {
    const res = await app().request(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      machine: { id: 'node-self', name: 'This machine' },
      runsOn: null,
      profile: { id: 'p1', name: 'Live profile' },
      calls: [{ callId: 'value', tool: 'mcp__Live__lookup', serverName: 'Live', toolName: 'lookup', description: 'Looks up the value for a key. Read-only.', state: 'needs_ok', args: LIVE.calls[0]!.args, params: LIVE.calls[0]!.params }],
    });
  });

  it('allow needs JSON, then creates the grant', async () => {
    expect((await app().request(`${BASE}/allow`, { method: 'POST' })).status).toBe(415);
    const res = await send('POST', `${BASE}/allow`, {});
    expect(res.status).toBe(200);
    expect(((await json(res))['calls'] as { state: string }[])[0]!.state).toBe('allowed');
    expect(store.grants.list('c1')).toHaveLength(1);
  });

  it('a call before allow is not_approved, and after it returns data', async () => {
    expect(await json(await send('POST', `${BASE}/calls/value`, { params: { key: 'b' } }))).toMatchObject({ ok: false, code: 'not_approved' });
    await send('POST', `${BASE}/allow`, {});
    expect(await json(await send('POST', `${BASE}/calls/value`, { params: { key: 'b' } }))).toMatchObject({ ok: true, cached: false, json: { value: 'value-of-b' } });
  });

  it('builds the arguments from the stored declaration, never from the request', async () => {
    await send('POST', `${BASE}/allow`, {});
    const res = await send('POST', `${BASE}/calls/value`, { params: { key: 'b' }, args: { key: 'evil' }, tool: 'mcp__Live__set_value', hash: 'x' });
    expect(await json(res)).toMatchObject({ ok: true, json: { key: 'b' } });
  });

  it('answers bad params, an unknown call, a body that is not an object, a version with no declaration and a missing reply', async () => {
    expect(await json(await send('POST', `${BASE}/calls/value`, { params: { key: 'c' } }))).toMatchObject({ ok: false, code: 'bad_params' });
    expect(await json(await send('POST', `${BASE}/calls/value`, { params: { key: 14 } }))).toMatchObject({ ok: false, code: 'bad_params' });
    expect((await send('POST', `${BASE}/calls/nope`, {})).status).toBe(404);
    expect((await send('POST', `${BASE}/calls/value`, [1])).status).toBe(400);
    expect((await app().request('/api/chats/c1/artifacts/art/versions/v-plain/live')).status).toBe(409);
    expect((await send('POST', '/api/chats/c1/artifacts/art/versions/v-orphan/live/calls/value', {})).status).toBe(409);
    expect((await app().request('/api/chats/c1/artifacts/art/versions/nope/live')).status).toBe(404);
  });

  it('refuses params that are null, an array or a scalar as bad_params, and takes absent params as the defaults', async () => {
    await send('POST', `${BASE}/allow`, {});
    for (const params of [null, [], ['b'], 'b', 7, true]) {
      expect(await json(await send('POST', `${BASE}/calls/value`, { params }))).toMatchObject({ ok: false, code: 'bad_params' });
    }
    expect(await json(await send('POST', `${BASE}/calls/value`, {}))).toMatchObject({ ok: true, json: { key: 'a' } });
  });

  it("DELETE revokes the artifact's live grants", async () => {
    await send('POST', `${BASE}/allow`, {});
    const res = await app().request('/api/chats/c1/artifacts/art/live', { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(204);
    expect(store.grants.list('c1')).toEqual([]);
  });

  it('names the machine a chat runs on when that is another one', async () => {
    store.chats.update('c1', { runsOn: 'node-laptop' });
    expect((await json(await app().request(BASE)))['runsOn']).toEqual({ id: 'node-laptop', name: 'node-laptop' });
  });

  it("404s a version of another artifact in the chat, and an artifact of another chat, on status and on a call", async () => {
    store.artifacts.create({ id: 'art-2', chatId: 'c1', slug: 'other', kind: 'html', language: null, createdAt: 5 });
    store.artifacts.addVersion({ id: 'v2', artifactId: 'art-2', title: 'Other', content: '<p></p>', madeBy: 'model', messageId: 'a1', parentVersionId: null, createdAt: 6, live: LIVE });
    store.chats.create({ id: 'c2', title: 'C2', profileId: 'p1', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    await send('POST', `${BASE}/allow`, {});
    for (const base of [
      '/api/chats/c1/artifacts/art/versions/v2/live',
      '/api/chats/c1/artifacts/art-2/versions/v1/live',
      '/api/chats/c2/artifacts/art/versions/v1/live',
      '/api/chats/c2/artifacts/art-2/versions/v2/live',
    ]) {
      expect((await app().request(base)).status, base).toBe(404);
      expect((await send('POST', `${base}/calls/value`, { params: { key: 'b' } })).status, base).toBe(404);
    }
  });

  it('bypasses the cache only for fresh: true, not "true" or 1', async () => {
    await send('POST', `${BASE}/allow`, {});
    expect(await json(await send('POST', `${BASE}/calls/value`, { params: { key: 'b' } }))).toMatchObject({ ok: true, cached: false, json: { n: 1 } });
    expect(await json(await send('POST', `${BASE}/calls/value`, { params: { key: 'b' }, fresh: 'true' }))).toMatchObject({ ok: true, cached: true, json: { n: 1 } });
    expect(await json(await send('POST', `${BASE}/calls/value`, { params: { key: 'b' }, fresh: 1 }))).toMatchObject({ ok: true, cached: true, json: { n: 1 } });
    expect(await json(await send('POST', `${BASE}/calls/value`, { params: { key: 'b' }, fresh: true }))).toMatchObject({ ok: true, cached: false, json: { n: 2 } });
  });

  it('refuses a write from an opaque-origin page', async () => {
    const res = await app().request(`${BASE}/allow`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }, body: '{}' });
    expect(res.status).toBe(403);
    expect(store.grants.list('c1')).toEqual([]);
  });
});
