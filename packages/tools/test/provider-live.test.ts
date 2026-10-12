import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveCallHash } from '@grunt/core/domain/live-artifacts.js';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import type { LiveCall } from '@grunt/core/ports/store.js';
import type { LiveRunRequest, ToolContext } from '@grunt/core/ports/tool-provider.js';
import { FakeSecretStore, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';
import { liveToolRisks } from '../src/artifact-tool.js';
import { McpServerManager } from '../src/mcp/manager.js';
import { GruntToolProvider } from '../src/provider.js';

/** Live artifacts (spec 2026-10-12-live-artifacts) against the real fixture over stdio. */
const LIVE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-server.js');
const SERVER = 'srv-live';

const lookupCall: LiveCall = { id: 'value', tool: 'mcp__Live__lookup', args: { key: { $param: 'key' } }, params: { key: { enum: ['a', 'b'], default: 'a' } } };
const setCall: LiveCall = { id: 'set', tool: 'mcp__Live__set_value', args: { key: 'a', value: 'b' }, params: {} };
const waitCall: LiveCall = { id: 'wait', tool: 'mcp__Live__wait', args: { ms: 2000 }, params: {} };

let store: InMemoryStore;
let manager: McpServerManager;
let provider: GruntToolProvider;

const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'off', shell: false, mcpServerIds: [SERVER], approvalMode: 'always_ask', ...over });
const statusReq = (calls: LiveCall[], over: Record<string, unknown> = {}) => ({
  chatId: 'chat-1', profileId: 'profile-1', policy: policy(), artifactId: 'art-1', calls: calls.map((call) => ({ call, hash: liveCallHash(call) })), ...over,
});
const run = (call: LiveCall, args: Record<string, unknown>, over: Partial<LiveRunRequest> = {}) =>
  provider.runLiveCall({
    chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', policy: policy(), artifactId: 'art-1',
    callId: call.id, hash: liveCallHash(call), toolName: call.tool, args, fresh: false, signal: new AbortController().signal, ...over,
  });

beforeEach(async () => {
  store = new InMemoryStore();
  store.mcpServers.create({ id: SERVER, name: 'Live', transport: 'stdio', command: process.execPath, args: [LIVE_FIXTURE], envRefs: {}, url: null, headerRefs: {}, enabled: true, status: 'unknown', toolsCache: null });
  const broker = new PermissionBroker(store);
  manager = new McpServerManager(store, new FakeSecretStore(), { initialBackoffMs: 50, maxBackoffMs: 100 });
  provider = new GruntToolProvider(store, broker, manager, { liveTimeoutMs: 300 });
  await manager.sync();
  await vi.waitFor(
    () => {
      if (manager.listFor([SERVER]).length !== 1) throw new Error('not connected yet');
    },
    { timeout: 5000, interval: 25 }
  );
});

afterEach(async () => {
  await manager.shutdown();
});

describe('GruntToolProvider live calls', () => {
  it('is not_approved and audited deny:policy before allowLive; afterwards it returns data audited live:<grant id>', async () => {
    expect(await run(lookupCall, { key: 'b' })).toEqual({ ok: false, code: 'not_approved', message: "You haven't allowed this live artifact's calls on this machine." });
    expect(store.audit.list('chat-1').map((a) => a.grantedBy)).toEqual(['deny:policy']);

    expect(provider.liveStatus(statusReq([lookupCall]))[0]!.state).toBe('needs_ok');
    const statuses = provider.allowLive(statusReq([lookupCall]));
    expect(statuses).toEqual([{ callId: 'value', tool: 'mcp__Live__lookup', serverName: 'Live', toolName: 'lookup', description: 'Looks up the value for a key. Read-only.', state: 'allowed' }]);
    const grant = store.grants.list('chat-1')[0]!;

    const ok = await run(lookupCall, { key: 'b' });
    expect(ok).toMatchObject({ ok: true, cached: false, json: { key: 'b', value: 'value-of-b', n: 1 }, structured: { key: 'b', value: 'value-of-b', n: 1 } });
    expect(store.audit.list('chat-1').at(-1)).toMatchObject({ toolName: 'mcp__Live__lookup', grantedBy: `live:${grant.id}`, messageId: 'msg-1' });
  });

  it('serves a second call from the cache with no new audit row; fresh calls the server again', async () => {
    provider.allowLive(statusReq([lookupCall]));
    const first = await run(lookupCall, { key: 'b' });
    const audits = store.audit.list('chat-1').length;
    expect(await run(lookupCall, { key: 'b' })).toMatchObject({ ok: true, cached: true, json: { n: 1 } });
    expect(store.audit.list('chat-1')).toHaveLength(audits);
    expect(await run(lookupCall, { key: 'b' }, { fresh: true })).toMatchObject({ ok: true, cached: false, json: { n: 2 } });
    // Other arguments are their own entry.
    expect(await run(lookupCall, { key: 'a' })).toMatchObject({ ok: true, cached: false, json: { n: 3 } });
    expect(first).toMatchObject({ json: { n: 1 } });
  });

  it("a cache hit doesn't change the stored entry: the next read after a hit is still cached and a fresh result replaces it", async () => {
    provider.allowLive(statusReq([lookupCall]));
    const first = await run(lookupCall, { key: 'b' });
    expect(first).toMatchObject({ cached: false });
    const hit = await run(lookupCall, { key: 'b' });
    expect(hit).toMatchObject({ cached: true });
    // The caller's first object stays what it was.
    expect(first).toMatchObject({ cached: false });
    expect(await run(lookupCall, { key: 'b' })).toMatchObject({ cached: true, json: { n: 1 } });
  });

  it("set_value is unavailable in liveStatus, allowLive doesn't grant it, and a call to it is refused", async () => {
    expect(provider.liveStatus(statusReq([setCall]))[0]).toMatchObject({
      state: 'unavailable',
      reason: '"mcp__Live__set_value" can change things; live artifacts can only use tools their server marks read-only.',
    });
    provider.allowLive(statusReq([setCall, lookupCall]));
    expect(store.grants.list('chat-1').map((g) => g.constraint?.live?.callId)).toEqual(['value']);
    expect(await run(setCall, { key: 'a', value: 'b' })).toMatchObject({ ok: false, code: 'refused' });
  });

  it('names a server the profile leaves out, one not set up, a missing tool, a disconnected server and one turned off', async () => {
    const outOfProfile = policy({ mcpServerIds: [] });
    expect(provider.liveStatus(statusReq([lookupCall], { policy: outOfProfile }))[0]).toMatchObject({ state: 'unavailable', reason: `MCP server "Live" isn't turned on for this chat's profile.` });
    expect(await run(lookupCall, { key: 'a' }, { policy: outOfProfile })).toEqual({ ok: false, code: 'not_available', message: `MCP server "Live" isn't turned on for this chat's profile.` });
    const ghost: LiveCall = { ...lookupCall, id: 'ghost', tool: 'mcp__Ghost__lookup' };
    expect(provider.liveStatus(statusReq([ghost]))[0]).toMatchObject({ serverName: 'Ghost', toolName: 'lookup', reason: `MCP server "Ghost" isn't set up on this machine.` });
    const missing: LiveCall = { id: 'missing', tool: 'mcp__Live__nope', args: {}, params: {} };
    expect(provider.liveStatus(statusReq([missing]))[0]).toMatchObject({ reason: `MCP server "Live" has no tool "nope".` });
    await manager.shutdown();
    expect(await run(lookupCall, { key: 'a' })).toEqual({ ok: false, code: 'not_available', message: `MCP server "Live" isn't connected.` });
    store.mcpServers.update(SERVER, { enabled: false });
    expect(provider.liveStatus(statusReq([lookupCall]))[0]).toMatchObject({ reason: `MCP server "Live" is turned off.` });
  });

  const ambiguous = '"mcp__Live__lookup" names more than one tool; rename one of the MCP servers so each has its own name.';
  const addSecondLive = async (over: { command?: string; args?: string[] } = {}) => {
    store.mcpServers.create({ id: 'srv-live-2', name: 'Live', transport: 'stdio', command: over.command ?? process.execPath, args: over.args ?? [LIVE_FIXTURE], envRefs: {}, url: null, headerRefs: {}, enabled: true, status: 'unknown', toolsCache: null });
    await manager.sync();
  };

  it('two servers with the same name both offering the tool: it is unavailable, never allowed and never called', async () => {
    await addSecondLive();
    await vi.waitFor(
      () => {
        if (manager.listFor([SERVER, 'srv-live-2']).length !== 2) throw new Error('not connected yet');
      },
      { timeout: 5000, interval: 25 }
    );
    const both = policy({ mcpServerIds: [SERVER, 'srv-live-2'] });
    expect(provider.liveStatus(statusReq([lookupCall], { policy: both }))[0]).toMatchObject({ state: 'unavailable', reason: ambiguous });
    expect(provider.allowLive(statusReq([lookupCall], { policy: both }))[0]).toMatchObject({ state: 'unavailable', reason: ambiguous });
    expect(store.grants.list('chat-1')).toEqual([]);
    expect(await run(lookupCall, { key: 'a' }, { policy: both })).toEqual({ ok: false, code: 'not_available', message: ambiguous });
    // Neither server was called: allowing the call with only the first server on, then calling with both, still calls nothing.
    provider.allowLive(statusReq([lookupCall]));
    expect(await run(lookupCall, { key: 'a' }, { policy: both })).toEqual({ ok: false, code: 'not_available', message: ambiguous });
    expect(await run(lookupCall, { key: 'a' }, { fresh: true })).toMatchObject({ ok: true, json: { n: 1 } });
  });

  it("a same-named server that isn't connected right now still makes the name ambiguous", async () => {
    await addSecondLive({ command: process.execPath, args: ['-e', 'process.exit(1)'] });
    const both = policy({ mcpServerIds: [SERVER, 'srv-live-2'] });
    expect(manager.listFor([SERVER, 'srv-live-2'])).toHaveLength(1);
    expect(provider.liveStatus(statusReq([lookupCall], { policy: both }))[0]).toMatchObject({ state: 'unavailable', reason: ambiguous });
    expect(await run(lookupCall, { key: 'a' }, { policy: both })).toMatchObject({ ok: false, code: 'not_available', message: ambiguous });
  });

  it('an unexpected throw comes back as failed, and a later call still works', async () => {
    provider.allowLive(statusReq([lookupCall]));
    const spy = vi.spyOn(store.grants, 'list').mockImplementation(() => {
      throw new Error('db gone '.repeat(100));
    });
    const out = await run(lookupCall, { key: 'a' });
    expect(out).toMatchObject({ ok: false, code: 'failed' });
    expect((out as { message: string }).message.length).toBeLessThanOrEqual(500);
    spy.mockRestore();
    expect(await run(lookupCall, { key: 'a' })).toMatchObject({ ok: true });
  });

  it('a call that outlives the timeout comes back as timeout', async () => {
    provider.allowLive(statusReq([waitCall]));
    expect(await run(waitCall, { ms: 2000 })).toMatchObject({ ok: false, code: 'timeout' });
  });

  it('a timed-out call frees its slot: more calls than the in-flight limit, one after another, are never rate_limited', async () => {
    provider.allowLive(statusReq([waitCall]));
    // Five timeouts in a row: with a leaked slot the fifth would be refused (4 in flight at most).
    for (let i = 0; i < 5; i += 1) {
      expect(await run(waitCall, { ms: 2000 }, { fresh: true })).toMatchObject({ ok: false, code: 'timeout' });
    }
  });

  it('an aborted call frees its slot too', async () => {
    provider.allowLive(statusReq([waitCall]));
    for (let i = 0; i < 5; i += 1) {
      const controller = new AbortController();
      const pending = run(waitCall, { ms: 2000 }, { fresh: true, signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      expect(await pending).toMatchObject({ ok: false });
    }
    provider.allowLive(statusReq([lookupCall]));
    expect(await run(lookupCall, { key: 'a' })).toMatchObject({ ok: true });
  });

  it("needs a fresh OK after the chat's profile changes", async () => {
    provider.allowLive(statusReq([lookupCall]));
    expect(provider.liveStatus(statusReq([lookupCall], { profileId: 'profile-2' }))[0]!.state).toBe('needs_ok');
    expect(await run(lookupCall, { key: 'a' }, { profileId: 'profile-2' })).toMatchObject({ ok: false, code: 'not_approved' });
  });

  it("a profile switch after allowing doesn't run under the old approval, not even from the cache", async () => {
    provider.allowLive(statusReq([lookupCall]));
    expect(await run(lookupCall, { key: 'b' })).toMatchObject({ ok: true, cached: false });
    // Same chat, same artifact, same args: now under another profile. The cached
    // answer for profile-1 must not be handed over, and the server isn't called.
    expect(await run(lookupCall, { key: 'b' }, { profileId: 'profile-2' })).toMatchObject({ ok: false, code: 'not_approved' });
    // Allowing it under profile-2 is its own decision and its own cache entry.
    provider.allowLive(statusReq([lookupCall], { profileId: 'profile-2' }));
    expect(await run(lookupCall, { key: 'b' }, { profileId: 'profile-2' })).toMatchObject({ ok: true, cached: false, json: { n: 2 } });
    // And going back to profile-1 still works from its own entry.
    expect(await run(lookupCall, { key: 'b' })).toMatchObject({ ok: true, cached: true, json: { n: 1 } });
  });

  it('revokeLive stops the calls', async () => {
    provider.allowLive(statusReq([lookupCall]));
    expect(provider.revokeLive('chat-1', 'art-1')).toBe(1);
    expect(await run(lookupCall, { key: 'a' }, { fresh: true })).toMatchObject({ ok: false, code: 'not_approved' });
  });

  it('revokeLive also stops a call that was cached before it', async () => {
    provider.allowLive(statusReq([lookupCall]));
    expect(await run(lookupCall, { key: 'a' })).toMatchObject({ ok: true });
    provider.revokeLive('chat-1', 'art-1');
    expect(await run(lookupCall, { key: 'a' })).toMatchObject({ ok: false, code: 'not_approved' });
  });

  it("the artifact tool refuses a mutating tool at creation and takes a read-only one", async () => {
    const artifact = (await provider.listTools(policy())).find((t) => t.name === 'artifact')!;
    const ctx: ToolContext = { chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null, signal: new AbortController().signal };
    const create = (calls: LiveCall[], id: string) => artifact.execute({ command: 'create', id, kind: 'html', title: 'Dash', content: '', live: JSON.stringify({ calls }) }, ctx);
    expect(await create([setCall], 'one')).toMatchObject({ error: true, code: 'not_read_only' });
    expect(await create([lookupCall], 'two')).toMatchObject({ ok: true, live: { calls: ['value'] } });
  });
});

describe('liveToolRisks', () => {
  it("maps the MCP tools' names to their risk, leaving other tools out", () => {
    const spec = (name: string, source: 'mcp' | 'fs', risk: 'read' | 'mutate') => ({ name, description: '', parameters: {}, risk, source, execute: async () => null });
    expect(liveToolRisks([spec('mcp__a__b', 'mcp', 'read'), spec('mcp__a__c', 'mcp', 'mutate'), spec('read_file', 'fs', 'read')])).toEqual(new Map([['mcp__a__b', 'read'], ['mcp__a__c', 'mutate']]));
  });
});
