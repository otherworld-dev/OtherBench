import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionBroker } from '@otherbench/core/domain/permissions.js';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FAKE_COMPUTER_APP, FakeComputerDriver } from '@otherbench/core/testing/fake-computer.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@otherbench/core/testing/fakes.js';
import type { ApprovalRequest } from '@otherbench/core/ports/tool-provider.js';
import { BrowserManager } from '@otherbench/tools/browser/manager.js';
import { McpServerManager } from '@otherbench/tools/mcp/manager.js';
import { OtherBenchToolProvider } from '@otherbench/tools/provider.js';
import { FakeFactory, fakeProxy } from '../../../tools/test/browser/fakes.js';
import { createApp } from '../../src/app.js';
import { parseApprovalChoice } from '../../src/routes/tools.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'test', 'fixtures', 'echo-server.js');

let store: InMemoryStore;
let secrets: FakeSecretStore;
let toolProvider: OtherBenchToolProvider;
let mcpManager: McpServerManager;
let container: Container;

beforeEach(() => {
  store = new InMemoryStore();
  secrets = new FakeSecretStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  const broker = new PermissionBroker(store);
  mcpManager = new McpServerManager(store, secrets, { initialBackoffMs: 50, maxBackoffMs: 100 });
  toolProvider = new OtherBenchToolProvider(store, broker, mcpManager);
  container = {
    store,
    secrets,
    engine,
    registry: {} as never,
    toolProvider,
    mcpManager,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
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
  it('creates a server (storing header AND env values as secrets, never plaintext), lists it, and connects it for real', async () => {
    const res = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Echo Fixture',
        transport: 'stdio',
        command: process.execPath,
        args: [FIXTURE_PATH],
        env: { API_KEY: 'super-secret-env-value' },
        headers: { 'X-Test': 'super-secret-header-value' },
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; envRefs: Record<string, string>; headerRefs: Record<string, string> };
    // Neither raw value may ever appear in the response body -- only refs.
    expect(JSON.stringify(created)).not.toContain('super-secret-env-value');
    expect(JSON.stringify(created)).not.toContain('super-secret-header-value');
    expect(await secrets.get(created.envRefs['API_KEY']!)).toBe('super-secret-env-value');

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

  it('stores stdio ENV VALUES as SecretStore refs, not plaintext, and a PATCH replacing env updates the value and drops refs for removed keys', async () => {
    const res = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Env Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH], env: { TOKEN: 'first-secret' } }),
    });
    const created = (await res.json()) as { id: string; envRefs: Record<string, string> };
    expect(Object.keys(created.envRefs)).toEqual(['TOKEN']);
    expect(created.envRefs['TOKEN']).not.toBe('first-secret');
    const tokenRef = created.envRefs['TOKEN']!;
    expect(await secrets.get(tokenRef)).toBe('first-secret');

    // Replace TOKEN's value -- the ref is deterministic (same server + same
    // var name), so it's reused, but the secret it points at is updated.
    const patchRes = await app().request(`/api/mcp-servers/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: { TOKEN: 'second-secret' } }),
    });
    const updated = (await patchRes.json()) as { envRefs: Record<string, string> };
    expect(await secrets.get(updated.envRefs['TOKEN']!)).toBe('second-secret');

    // Now drop TOKEN entirely (a different var name) -- its old ref must no
    // longer resolve, not be left dangling.
    const secondPatchRes = await app().request(`/api/mcp-servers/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: { OTHER_VAR: 'third-secret' } }),
    });
    const secondUpdate = (await secondPatchRes.json()) as { envRefs: Record<string, string> };
    expect(Object.keys(secondUpdate.envRefs)).toEqual(['OTHER_VAR']);
    expect(await secrets.get(tokenRef)).toBeNull();
  });

  it('CRITICAL: a PATCH that explicitly keeps every existing env var (null) leaves every one still resolvable from SecretStore -- an "edit, change nothing, save" must never destroy a secret', async () => {
    // This is the server-side half of the destroy-on-noop-save bug: the
    // client (`McpServerForm`) pre-seeds a row per existing name with a
    // blank value and, if the user never types into it, now sends `null`
    // for that name (see `rowsToSecretPatch`) instead of either omitting it
    // (which `PATCH` treats as "delete") or the old bug's `""` (which
    // deleted just as surely). The real regression check is that the value
    // still RESOLVES from SecretStore afterwards, not merely that the refs
    // map looks non-empty in the response body.
    const res = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Keep Srv',
        transport: 'stdio',
        command: process.execPath,
        args: [FIXTURE_PATH],
        env: { GITHUB_TOKEN: 'gh-secret-value', KEEP: 'keep-secret-value' },
      }),
    });
    const created = (await res.json()) as { id: string; envRefs: Record<string, string> };

    const patchRes = await app().request(`/api/mcp-servers/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: { GITHUB_TOKEN: null, KEEP: null } }),
    });
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as { envRefs: Record<string, string> };

    expect(Object.keys(updated.envRefs).sort()).toEqual(['GITHUB_TOKEN', 'KEEP']);
    expect(await secrets.get(updated.envRefs['GITHUB_TOKEN']!)).toBe('gh-secret-value');
    expect(await secrets.get(updated.envRefs['KEEP']!)).toBe('keep-secret-value');
  });

  it('the identical "keep" (null) semantics apply to headers on an http server', async () => {
    const res = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Keep Headers Srv', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer keep-me' } }),
    });
    const created = (await res.json()) as { id: string; headerRefs: Record<string, string> };

    const patchRes = await app().request(`/api/mcp-servers/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headers: { Authorization: null } }),
    });
    const updated = (await patchRes.json()) as { headerRefs: Record<string, string> };
    expect(await secrets.get(updated.headerRefs['Authorization']!)).toBe('Bearer keep-me');
  });

  it('IMPORTANT 6: rejects an empty-string secret value with 400, on both POST and PATCH, for env and headers', async () => {
    const createEmptyEnv = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH], env: { GITHUB_TOKEN: '' } }),
    });
    expect(createEmptyEnv.status).toBe(400);

    const createEmptyHeader = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad Srv 2', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: '' } }),
    });
    expect(createEmptyHeader.status).toBe(400);

    const goodRes = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Good Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH], env: { GITHUB_TOKEN: 'real-value' } }),
    });
    const good = (await goodRes.json()) as { id: string };

    const patchEmptyEnv = await app().request(`/api/mcp-servers/${good.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: { GITHUB_TOKEN: '' } }),
    });
    expect(patchEmptyEnv.status).toBe(400);
    // Rejected -- the previously-stored value must be untouched.
    expect(store.mcpServers.get(good.id)!.envRefs).toEqual({ GITHUB_TOKEN: expect.any(String) });
  });

  it('MINOR 10: PATCH re-applies transport conditioning -- switching stdio->http cleans up envRefs/secrets, http->stdio cleans up headerRefs/secrets and the stale url', async () => {
    const stdioRes = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Switchy', transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH], env: { TOKEN: 'will-be-orphaned' } }),
    });
    const created = (await stdioRes.json()) as { id: string; envRefs: Record<string, string> };
    const orphanedRef = created.envRefs['TOKEN']!;
    expect(await secrets.get(orphanedRef)).toBe('will-be-orphaned');

    const toHttp = await app().request(`/api/mcp-servers/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transport: 'http', url: 'https://example.com/mcp' }),
    });
    expect(toHttp.status).toBe(200);
    const afterToHttp = (await toHttp.json()) as { envRefs: Record<string, string>; headerRefs: Record<string, string>; command: string | null };
    expect(afterToHttp.envRefs).toEqual({});
    expect(afterToHttp.command).toBeNull();
    // The old env secret is gone, not orphaned in SecretStore.
    expect(await secrets.get(orphanedRef)).toBeNull();

    const toHttpWithHeader = await app().request(`/api/mcp-servers/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headers: { Authorization: 'Bearer switched' } }),
    });
    const withHeader = (await toHttpWithHeader.json()) as { headerRefs: Record<string, string> };
    const headerRef = withHeader.headerRefs['Authorization']!;
    expect(await secrets.get(headerRef)).toBe('Bearer switched');

    const backToStdio = await app().request(`/api/mcp-servers/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH] }),
    });
    expect(backToStdio.status).toBe(200);
    const afterBackToStdio = (await backToStdio.json()) as { headerRefs: Record<string, string>; url: string | null };
    expect(afterBackToStdio.headerRefs).toEqual({});
    expect(afterBackToStdio.url).toBeNull();
    expect(await secrets.get(headerRef)).toBeNull();
  });

  it('an explicit env/headers in the SAME PATCH that flips transport is ignored for the now-irrelevant side, not applied -- a transport is a mode, not two independent field sets', async () => {
    // Regression coverage: the transport-conditioning logic used to gate
    // cleanup of the OTHER side's refs on `transportChanged`, but applied
    // an explicitly-provided `env`/`headers` unconditionally -- so
    // `{"transport":"http","env":{...}}` in one request stored env refs on
    // an http row, contradicting the surrounding comment's own claim that
    // switching to http clears env. Not reachable from the UI (the form
    // only ever sends `env` for stdio / `headers` for http), but a real gap
    // in what the API itself allows.
    const stdioRes = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mode Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH] }),
    });
    const created = (await stdioRes.json()) as { id: string };

    // Flips to http AND supplies `env` in the very same request.
    const toHttpWithEnv = await app().request(`/api/mcp-servers/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transport: 'http', url: 'https://example.com/mcp', env: { LEFTOVER: 'should-not-be-stored' } }),
    });
    expect(toHttpWithEnv.status).toBe(200);
    const afterToHttp = (await toHttpWithEnv.json()) as { transport: string; envRefs: Record<string, string> };
    expect(afterToHttp.transport).toBe('http');
    // Meaningless on an http row -- must be empty, not carrying LEFTOVER.
    expect(afterToHttp.envRefs).toEqual({});
    expect(store.mcpServers.get(created.id)!.envRefs).toEqual({});

    // Flips back to stdio AND supplies `headers` in the very same request.
    const toStdioWithHeaders = await app().request(`/api/mcp-servers/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH], headers: { 'X-Leftover': 'should-not-be-stored' } }),
    });
    expect(toStdioWithHeaders.status).toBe(200);
    const afterToStdio = (await toStdioWithHeaders.json()) as { transport: string; headerRefs: Record<string, string> };
    expect(afterToStdio.transport).toBe('stdio');
    expect(afterToStdio.headerRefs).toEqual({});
    expect(store.mcpServers.get(created.id)!.headerRefs).toEqual({});
  });

  it('GET /mcp-servers/:id returns the full stored config (refs, not plaintext), 404s for an unknown id', async () => {
    const createRes = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Srv', transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH], env: { A: 'secretval' } }),
    });
    const created = (await createRes.json()) as { id: string };

    const getRes = await app().request(`/api/mcp-servers/${created.id}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as { id: string; command: string; envRefs: Record<string, string> };
    expect(fetched.id).toBe(created.id);
    expect(fetched.command).toBe(process.execPath);
    expect(JSON.stringify(fetched)).not.toContain('secretval');

    const missing = await app().request('/api/mcp-servers/does-not-exist');
    expect(missing.status).toBe(404);
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

  it('a PATCH that changes a connected server\'s env restarts it so the change takes effect', async () => {
    const createRes = await app().request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Restartable', transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH], env: { A: 'one' } }),
    });
    const { id } = (await createRes.json()) as { id: string };
    await waitFor(() => mcpManager.health().find((h) => h.id === id)?.status === 'ok');
    const before = mcpManager.listFor([id])[0]!.client;

    await app().request(`/api/mcp-servers/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ env: { A: 'two' } }) });
    await waitFor(() => mcpManager.health().find((h) => h.id === id)?.status === 'ok');
    expect(mcpManager.listFor([id])[0]!.client).not.toBe(before);
  });

  it('refresh forces a reconnect and 404s for an unknown server', async () => {
    store.mcpServers.create({
      id: 'srv-x',
      name: 'X',
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE_PATH],
      envRefs: {},
      url: null,
      headerRefs: {},
      enabled: true,
      status: 'unknown',
      toolsCache: null,
      oauth: null,
    });
    await mcpManager.sync();
    await waitFor(() => mcpManager.health()[0]?.status === 'ok');

    const res = await app().request('/api/mcp-servers/srv-x/refresh', { method: 'POST' });
    expect(res.status).toBe(204);

    const missing = await app().request('/api/mcp-servers/does-not-exist/refresh', { method: 'POST' });
    expect(missing.status).toBe(404);
  });
});

describe('Import from Claude Desktop', () => {
  let dir: string;
  // A command no machine has: the import's MCP sync must never start anything real.
  const NO_SUCH = 'otherbench-test-no-such-command';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'otherbench-desktop-import-'));
    vi.stubEnv('OTHERBENCH_CLAUDE_DESKTOP_CONFIG', join(dir, 'claude_desktop_config.json'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  const writeConfig = (content: string): void => writeFileSync(join(dir, 'claude_desktop_config.json'), content);
  const config = (): void =>
    writeConfig(
      JSON.stringify({
        mcpServers: {
          blender: { command: NO_SUCH, args: ['blender'] },
          'Home Assistant': { command: NO_SUCH, args: ['ha'], env: { HOMEASSISTANT_TOKEN: 'very-secret-token', HOMEASSISTANT_URL: 'http://ha.local' } },
          legacy: { type: 'sse', url: 'https://mcp.example.com/sse' },
        },
      })
    );
  const postImport = (body: unknown) =>
    app().request('/api/mcp-servers/import/claude-desktop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('lists the servers it finds by name, never with their values, marking ones OtherBench has and ones it cannot use', async () => {
    config();
    store.mcpServers.create({ id: 'existing', name: 'blender', transport: 'stdio', command: NO_SUCH, args: [], envRefs: {}, url: null, headerRefs: {}, enabled: false, status: 'unknown', toolsCache: null, oauth: null });
    const res = await app().request('/api/mcp-servers/import/claude-desktop');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('very-secret-token');
    const body = JSON.parse(text) as { path: string; found: boolean; servers: Record<string, unknown>[] };
    expect(body).toMatchObject({ path: join(dir, 'claude_desktop_config.json'), found: true });
    const byName = Object.fromEntries(body.servers.map((s) => [s['name'], s]));
    expect(byName['Home Assistant']).toMatchObject({ transport: 'stdio', command: NO_SUCH, args: ['ha'], envNames: ['HOMEASSISTANT_TOKEN', 'HOMEASSISTANT_URL'], exists: false, supported: true });
    expect(byName['Home Assistant']).not.toHaveProperty('env');
    expect(byName['blender']).toMatchObject({ exists: true });
    expect(byName['legacy']).toMatchObject({ supported: false, reason: expect.stringContaining('SSE') });
  });

  it('says when Claude Desktop has no config here, and refuses one that is not JSON', async () => {
    expect(await (await app().request('/api/mcp-servers/import/claude-desktop')).json()).toMatchObject({ found: false, servers: [] });
    writeConfig('{ nope');
    const bad = await app().request('/api/mcp-servers/import/claude-desktop');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('claude_desktop_config.json');
  });

  it('imports the chosen servers, their values going into the secret store, and skips the rest with reasons', async () => {
    config();
    store.mcpServers.create({ id: 'existing', name: 'blender', transport: 'stdio', command: NO_SUCH, args: [], envRefs: {}, url: null, headerRefs: {}, enabled: false, status: 'unknown', toolsCache: null, oauth: null });
    const res = await postImport({ names: ['Home Assistant', 'blender', 'legacy', 'ghost'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imported: string[]; skipped: { name: string; reason: string }[] };
    expect(body.imported).toEqual(['Home Assistant']);
    expect(body.skipped.map((s) => s.name)).toEqual(['blender', 'legacy', 'ghost']);
    expect(body.skipped[0]!.reason).toContain('already');
    const row = store.mcpServers.list().find((r) => r.name === 'Home Assistant')!;
    expect(row).toMatchObject({ transport: 'stdio', command: NO_SUCH, args: ['ha'], enabled: true });
    expect(Object.keys(row.envRefs).sort()).toEqual(['HOMEASSISTANT_TOKEN', 'HOMEASSISTANT_URL']);
    expect(await secrets.get(row.envRefs['HOMEASSISTANT_TOKEN']!)).toBe('very-secret-token');
    expect(JSON.stringify(row)).not.toContain('very-secret-token');
  });

  it('skips an http server whose address holds a user name or password', async () => {
    writeConfig(JSON.stringify({ mcpServers: { sneaky: { type: 'http', url: 'https://good.example@evil.example/mcp' } } }));
    const body = (await (await postImport({ names: ['sneaky'] })).json()) as { imported: string[]; skipped: { name: string; reason: string }[] };
    expect(body.imported).toEqual([]);
    expect(body.skipped).toEqual([{ name: 'sneaky', reason: "A server address can't hold a user name or password. Send credentials in a header instead." }]);
    expect(store.mcpServers.list()).toEqual([]);
  });

  const profile = (id: string, mcpServerIds: string[]) =>
    store.profiles.create({
      id,
      name: `Profile ${id}`,
      description: null,
      colour: null,
      connectionId: 'conn-1',
      modelId: 'model-x',
      systemPrompt: null,
      params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds, approvalMode: 'ask_on_mutate' },
      isDefault: false,
      archivedAt: null,
    });

  it('turns the imported servers on for the chosen profiles, keeping what those already had', async () => {
    config();
    profile('pa', ['already-on']);
    profile('pb', []);
    const res = await postImport({ names: ['Home Assistant', 'blender', 'legacy'], profileIds: ['pa'] });
    expect(res.status).toBe(200);
    const ids = ['Home Assistant', 'blender'].map((n) => store.mcpServers.list().find((r) => r.name === n)!.id);
    expect(store.profiles.get('pa')!.toolPolicy.mcpServerIds).toEqual(['already-on', ...ids]);
    expect(store.profiles.get('pb')!.toolPolicy.mcpServerIds).toEqual([]);
    const body = (await res.json()) as { profiles: { id: string; toolPolicy: { mcpServerIds: string[] } }[] };
    expect(body.profiles.map((p) => [p.id, p.toolPolicy.mcpServerIds])).toEqual([['pa', ['already-on', ...ids]]]);
  });

  it('leaves profiles alone when no profile is chosen or nothing was imported', async () => {
    config();
    profile('pa', []);
    expect(await (await postImport({ names: ['blender'] })).json()).toMatchObject({ imported: ['blender'], profiles: [] });
    expect(await (await postImport({ names: ['blender'], profileIds: ['pa'] })).json()).toMatchObject({ imported: [], profiles: [] });
    expect(store.profiles.get('pa')!.toolPolicy.mcpServerIds).toEqual([]);
  });

  it('refuses an unknown profile, or a profile list that is not one, before importing anything', async () => {
    config();
    profile('pa', []);
    const res = await postImport({ names: ['Home Assistant'], profileIds: ['pa', 'nope'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('nope');
    expect((await postImport({ names: ['Home Assistant'], profileIds: 'pa' })).status).toBe(400);
    expect(store.mcpServers.list()).toEqual([]);
  });

  it('404s an import when there is no config, and 400s a names list that is not one', async () => {
    expect((await postImport({ names: ['x'] })).status).toBe(404);
    config();
    expect((await postImport({ names: 'Home Assistant' })).status).toBe(400);
    expect((await postImport({ names: [5] })).status).toBe(400);
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

  it("keeps a browser site's host through an 'always' answer, and refuses a host that is not a string", () => {
    expect(parseApprovalChoice({ choice: 'always', constraint: { host: 'example.com' } })).toEqual({
      choice: 'always',
      constraint: { host: 'example.com' },
    });
    expect(() => parseApprovalChoice({ choice: 'always', constraint: { host: 42 } })).toThrow(/constraint\.host/);
    expect(parseApprovalChoice({ choice: 'always', constraint: { commandExact: 'npm test' } })).toMatchObject({
      constraint: { commandExact: 'npm test' },
    });
  });

  it("an 'always' answer with a host stores a browser grant for that site", async () => {
    store.chats.create({ id: 'chat-b', title: 'B', profileId: 'profile-b', headMessageId: null, pinned: false, archivedAt: null } as never);
    const policy = { fs: 'off' as const, shell: false, mcpServerIds: [], approvalMode: 'always_ask' as const, browser: true };
    const browser = new BrowserManager({ factory: new FakeFactory(), startProxy: fakeProxy().start });
    const provider = new OtherBenchToolProvider(store, new PermissionBroker(store), mcpManager, { browser });
    container.toolProvider = provider;
    const requests: ApprovalRequest[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') requests.push(e.request);
    });
    const tool = (await provider.listTools(policy)).find((t) => t.name === 'browser')!;
    const run = tool.execute(
      { command: 'open', url: 'https://example.com/page' },
      { chatId: 'chat-b', messageId: 'msg-b', profileId: 'profile-b', workspaceRoot: '/x', signal: new AbortController().signal }
    );
    for (let i = 0; i < 20 && requests.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(requests).toHaveLength(1);
    const res = await app().request(`/api/approvals/${requests[0]!.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'always', constraint: { host: 'example.com' } }),
    });
    expect(res.status).toBe(200);
    await run.catch(() => {});
    const grants = store.grants.list().filter((g) => g.source === 'browser');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ toolName: 'browser', scope: 'always', constraint: { host: 'example.com' } });
  });

  it("a browser card's 'always' answer is held to the sandbox network's rules: one key, the card's own host, stored canonical", async () => {
    store.chats.create({ id: 'chat-b', title: 'B', profileId: 'profile-b', headMessageId: null, pinned: false, archivedAt: null } as never);
    const policy = { fs: 'off' as const, shell: false, mcpServerIds: [], approvalMode: 'always_ask' as const, browser: true };
    const browser = new BrowserManager({ factory: new FakeFactory(), startProxy: fakeProxy().start });
    const provider = new OtherBenchToolProvider(store, new PermissionBroker(store), mcpManager, { browser });
    container.toolProvider = provider;
    const requests: ApprovalRequest[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') requests.push(e.request);
    });
    const tool = (await provider.listTools(policy)).find((t) => t.name === 'browser')!;
    const open = async (constraint: unknown): Promise<number> => {
      const before = requests.length;
      const run = tool.execute(
        { command: 'open', url: 'https://example.com/page' },
        { chatId: 'chat-b', messageId: 'msg-b', profileId: 'profile-b', workspaceRoot: '/x', signal: new AbortController().signal }
      );
      for (let i = 0; i < 20 && requests.length === before; i++) await new Promise((r) => setTimeout(r, 10));
      expect(requests).toHaveLength(before + 1);
      const id = requests[before]!.id;
      const post = (body: unknown) => app().request(`/api/approvals/${id}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const res = await post({ choice: 'always', constraint });
      // A refused body leaves the card waiting; take it down so the call ends.
      if (res.status !== 200) expect((await post({ choice: 'deny' })).status).toBe(200);
      await run.catch(() => {});
      return res.status;
    };
    const browserGrants = () => store.grants.list().filter((g) => g.source === 'browser');

    // The route refuses a second key and a key it doesn't know, as it does for a network card.
    expect(await open({ host: 'example.com', pathPrefix: '.' })).toBe(400);
    expect(await open({ host: 'example.com', site: 'example.com' })).toBe(400);
    // The broker refuses another site, a subdomain and no site at all: the call was approved once, and nothing is stored.
    expect(await open({ host: 'evil.test' })).toBe(200);
    expect(await open({ host: 'www.example.com' })).toBe(200);
    expect(await open(null)).toBe(200);
    expect(browserGrants()).toEqual([]);
    // The card's own host, in another spelling: stored canonical.
    expect(await open({ host: 'EXAMPLE.com.' })).toBe(200);
    expect(browserGrants()).toEqual([expect.objectContaining({ toolName: 'browser', scope: 'always', chatId: null, constraint: { host: 'example.com' } })]);
    // And a network call for the same host gets nothing from it.
    expect(store.grants.list().filter((g) => g.source === 'network')).toEqual([]);
  });

  it('rejects a malformed choice with 400', async () => {
    const res = await app().request('/api/approvals/whatever/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it("keeps a computer grant's app through an 'always' answer exactly as it came, and refuses one that is not a string", () => {
    const app = 'C:\\Program Files\\Fake App\\FakeApp.exe';
    expect(parseApprovalChoice({ choice: 'always', constraint: { app } })).toEqual({ choice: 'always', constraint: { app } });
    // The broker judges the key (`appKey`); nothing on the way may repair it. Spaces at the ends, another
    // letter case, forward slashes, an accented letter composed and decomposed, a look-alike letter, an
    // empty string and a hidden character all arrive as they were sent.
    const asSent = [
      ' C:\\Apps\\Tool.exe ',
      'c:\\APPS\\tool.EXE',
      'C:/Apps/Tool.exe',
      'C:\\Users\\Jos\u00e9\\Tool.exe',
      'C:\\Users\\Jose\u0301\\Tool.exe',
      'C:\\Apps\\\u212a.exe',
      'C:\\Apps\\Tool\u200b.exe',
      'C:\\Apps\\Tool.exe\r\n',
      '',
    ];
    for (const raw of asSent) {
      const parsed = parseApprovalChoice({ choice: 'always', constraint: { app: raw } });
      expect(parsed, JSON.stringify(raw)).toEqual({ choice: 'always', constraint: { app: raw } });
      expect((parsed as { constraint: { app: string } }).constraint.app === raw, JSON.stringify(raw)).toBe(true);
    }
    for (const bad of [42, null, true, ['C:\\Apps\\Tool.exe'], { path: 'C:\\Apps\\Tool.exe' }]) {
      expect(() => parseApprovalChoice({ choice: 'always', constraint: { app: bad } }), JSON.stringify(bad)).toThrow(/"constraint\.app" must be a string\./);
    }
    // The other keys are untouched by it, and an app is only there when one was sent.
    expect(parseApprovalChoice({ choice: 'always', constraint: { host: 'example.com' } })).toEqual({ choice: 'always', constraint: { host: 'example.com' } });
    expect('app' in ((parseApprovalChoice({ choice: 'always', constraint: { host: 'example.com' } }) as { constraint: object }).constraint)).toBe(false);
    // One key at a time, as for a host (integration): an app beside anything else is refused here, before the broker.
    for (const extra of [{ host: 'example.com' }, { commandExact: 'x' }, { pathPrefix: '/' }]) {
      expect(() => parseApprovalChoice({ choice: 'always', constraint: { app, ...extra } }), JSON.stringify(extra)).toThrow(/must set only one key/);
    }
    expect(parseApprovalChoice({ choice: 'always', constraint: {} })).toEqual({ choice: 'always', constraint: null });
  });

  it("an 'always' answer with the card's app stores a computer grant for exactly that app; one that is not a string is a 400 and stores nothing", async () => {
    store.chats.create({ id: 'chat-c', title: 'C', profileId: 'profile-c', headMessageId: null, pinned: false, archivedAt: null } as never);
    const policy = { fs: 'off' as const, shell: false, mcpServerIds: [], approvalMode: 'always_ask' as const, computer: true };
    const driver = new FakeComputerDriver();
    const provider = new OtherBenchToolProvider(store, new PermissionBroker(store), mcpManager, { computer: driver });
    container.toolProvider = provider;
    const requests: ApprovalRequest[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') requests.push(e.request);
    });
    const tool = (await provider.listTools(policy)).find((t) => t.name === 'computer')!;
    const ctx = { chatId: 'chat-c', messageId: 'msg-c', profileId: 'profile-c', workspaceRoot: null, signal: new AbortController().signal };
    // A point is in the last screenshot's pixels, so the chat looks first (no card for a look).
    await tool.execute({ action: 'screenshot' }, ctx);
    const run = tool.execute({ action: 'left_click', coordinate: [10, 20] }, ctx);
    await waitFor(() => requests.length === 1);
    const resolve = (constraint: unknown) =>
      app().request(`/api/approvals/${requests[0]!.id}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: 'always', constraint }) });

    expect((await resolve({ app: 42 })).status).toBe(400);
    expect(store.grants.list()).toEqual([]);
    expect(driver.actions).toEqual([]);

    const key = (requests[0]!.args as { app: string }).app;
    expect(key).toBe(FAKE_COMPUTER_APP.path);
    expect((await resolve({ app: key })).status).toBe(200);
    await run;
    const grants = store.grants.list().filter((g) => g.source === 'computer');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ toolName: 'computer', scope: 'always' });
    expect(grants[0]!.constraint).toEqual({ app: 'C:\\Program Files\\Fake App\\FakeApp.exe' });
    expect(driver.actions.map((a) => a.action)).toEqual([{ action: 'left_click', coordinate: [10, 20] }]);
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

describe('parseApprovalChoice: sandbox network grants', () => {
  it('keeps the host of an "always" constraint', () => {
    expect(parseApprovalChoice({ choice: 'always', constraint: { host: 'pypi.org' } })).toMatchObject({ choice: 'always', constraint: { host: 'pypi.org' } });
  });

  it('refuses a host that is not a string', () => {
    expect(() => parseApprovalChoice({ choice: 'always', constraint: { host: 42 } })).toThrow('"constraint.host" must be a string.');
  });

  it.each([[''], ['a'.repeat(254)]])('refuses a host of the wrong size (%#)', (host) => {
    expect(() => parseApprovalChoice({ choice: 'always', constraint: { host } })).toThrow('"constraint.host" must be 1-253 characters.');
  });

  it('refuses a constraint that mixes keys, and one with a key OtherBench does not know', () => {
    expect(() => parseApprovalChoice({ choice: 'always', constraint: { host: 'pypi.org', commandExact: 'ls' } })).toThrow('"constraint" must set only one key.');
    expect(() => parseApprovalChoice({ choice: 'always', constraint: { pathPrefix: 'src', commandPrefix: 'git' } })).toThrow('"constraint" must set only one key.');
    expect(() => parseApprovalChoice({ choice: 'always', constraint: { host: 'pypi.org', extra: 1 } })).toThrow('"constraint" has an unknown key "extra".');
  });

  it('still takes a single path or command key, and an empty constraint as none', () => {
    expect(parseApprovalChoice({ choice: 'always', constraint: { commandExact: 'ls' } })).toMatchObject({ constraint: { commandExact: 'ls' } });
    expect(parseApprovalChoice({ choice: 'always', constraint: {} })).toMatchObject({ choice: 'always', constraint: null });
  });
});

describe('Ask routes', () => {
  const post = (path: string, body: unknown) => app().request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ctx = () => ({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'p1', workspaceRoot: null, signal: new AbortController().signal });

  async function pendingQuestion(): Promise<{ id: string; outcome: Promise<unknown> }> {
    let id = '';
    const off = toolProvider.onApprovalEvent((e) => {
      if (e.type === 'ask') id = e.ask.id;
    });
    const outcome = toolProvider.askUser(ctx(), { kind: 'question', toolName: 'ask_user', questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false }] });
    off();
    return { id, outcome };
  }

  it('answers a pending question, then 404s the same id', async () => {
    const { id, outcome } = await pendingQuestion();
    const res = await post(`/api/asks/${id}/answer`, { answers: ['Blue'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answered: true });
    expect(await outcome).toEqual({ reply: { answers: ['Blue'] } });
    expect((await post(`/api/asks/${id}/answer`, { answers: ['Blue'] })).status).toBe(404);
  });

  it('400s a reply of the wrong kind with its reason, and a body of the wrong shape', async () => {
    const { id } = await pendingQuestion();
    const wrongKind = await post(`/api/asks/${id}/answer`, { approve: true });
    expect(wrongKind.status).toBe(400);
    expect(JSON.stringify(await wrongKind.json())).toContain('question');
    for (const bad of [{}, { answers: 'Blue' }, { declined: false }, { approve: true, changes: 'x' }, { changes: 3 }, { generate: 'a cat' }, { generate: { prompt: 3 } }, { generate: { prompt: 'a', negativePrompt: 4 } }]) {
      expect((await post(`/api/asks/${id}/answer`, bad)).status).toBe(400);
    }
  });

  it('404s an unknown id', async () => {
    expect((await post('/api/asks/never-existed/answer', { declined: true })).status).toBe(404);
  });
});
