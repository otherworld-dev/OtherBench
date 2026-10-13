import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import { InMemoryStore, FakeChatEngine } from '@grunt/core/testing/fakes.js';
import type { SecretStore } from '@grunt/core/ports/secret-store.js';
import { createSecretStore } from '@grunt/store-sqlite/secret-store.js';
import { McpServerManager } from '@grunt/tools/mcp/manager.js';
import { oauthRefs } from '@grunt/tools/mcp/oauth-store.js';
import { GruntToolProvider } from '@grunt/tools/provider.js';
import { createApp, type AppOptions } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { startOAuthEchoServer } from '../../../tools/test/fixtures/oauth-echo-server.js';
import { from, PASSWORD, remoteFixture, type RemoteFixture } from '../remote/helpers.js';

const PORT = 4747;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth/callback`;
const PUBLIC_REDIRECT = 'https://grunt.test:4747/oauth/callback';

let dir: string;
let store: InMemoryStore;
let secrets: SecretStore;
let mcpManager: McpServerManager;
let container: Container;
let fixture: Awaited<ReturnType<typeof startOAuthEchoServer>>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'grunt-mcp-oauth-'));
  store = new InMemoryStore();
  secrets = createSecretStore(join(dir, 'secrets.json'), 'test-passphrase');
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  mcpManager = new McpServerManager(store, secrets, { initialBackoffMs: 50, maxBackoffMs: 100 });
  container = {
    store,
    secrets,
    engine,
    registry: {} as never,
    toolProvider: new GruntToolProvider(store, new PermissionBroker(store), mcpManager),
    mcpManager,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    close: () => {},
  };
  fixture = await startOAuthEchoServer({ idTokenEmail: 'alice@example.com' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mcpManager.shutdown();
  await fixture.close();
  rmSync(dir, { recursive: true, force: true });
});

function app(options: AppOptions = { oauthCallbackPort: () => PORT }) {
  return createApp(container, options);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  await vi.waitFor(() => {
    if (!predicate()) throw new Error('condition not met yet');
  }, { timeout: timeoutMs, interval: 25 });
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function createServer(name = 'Hosted Docs', extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app().request('/api/mcp-servers', json({ name, transport: 'http', url: fixture.url, ...extra }));
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  // Let the background connect settle first, so it never races the sign-in a test starts.
  await waitFor(() => ['needs_auth', 'error', 'ok'].includes(mcpManager.health().find((h) => h.id === id)?.status ?? ''));
  return id;
}

const healthOf = (id: string) => mcpManager.health().find((h) => h.id === id)!;

async function startSignIn(id: string): Promise<string> {
  const res = await app().request(`/api/mcp-servers/${id}/sign-in`, { method: 'POST' });
  expect(res.status).toBe(200);
  return ((await res.json()) as { authorizationUrl: string }).authorizationUrl;
}

/** The address the browser ends on: Grunt's callback with the provider's query. */
async function endedOn(authorizationUrl: string): Promise<URL> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  return new URL(res.headers.get('location')!);
}

const callbackPath = (ended: URL) => `${ended.pathname}${ended.search}`;

describe('MCP sign-in routes', { timeout: 20_000 }, () => {
  it('POST sign-in returns the authorization URL for the bound redirect address', async () => {
    const id = await createServer();
    const url = new URL(await startSignIn(id));
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(healthOf(id).auth).toMatchObject({ pending: true });
  });

  it('POST sign-in: 404 unknown server, 409 fixed Authorization header, 503 when the port is unknown', async () => {
    expect((await app().request('/api/mcp-servers/nope/sign-in', { method: 'POST' })).status).toBe(404);

    const fixed = await createServer('Fixed', { headers: { Authorization: 'Bearer fixed' } });
    const conflict = await app().request(`/api/mcp-servers/${fixed}/sign-in`, { method: 'POST' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'This server sends a fixed Authorization header. Remove it to sign in with a browser instead.' });

    const id = await createServer('No port');
    expect((await app({}).request(`/api/mcp-servers/${id}/sign-in`, { method: 'POST' })).status).toBe(503);
  });

  it('refuses a server address with userinfo or a backslash on POST and PATCH, with a plain message', async () => {
    const userinfo = fixture.url.replace('http://', 'http://good@');
    const post = await app().request('/api/mcp-servers', json({ name: 'Userinfo', transport: 'http', url: userinfo }));
    expect(post.status).toBe(400);
    expect(await post.json()).toEqual({ error: "A server address can't hold a user name or password. Send credentials in a header instead." });
    const backslash = await app().request('/api/mcp-servers', json({ name: 'Backslash', transport: 'http', url: 'http://127.0.0.1:9\\@evil.example/mcp' }));
    expect(backslash.status).toBe(400);
    expect(store.mcpServers.list().map((r) => r.name)).not.toContain('Userinfo');

    const id = await createServer();
    const patch = await app().request(`/api/mcp-servers/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://user:pw@evil.example/mcp' }) });
    expect(patch.status).toBe(400);
    expect(store.mcpServers.get(id)!.url).toBe(fixture.url);
  });

  it('GET redirect-uri reports the redirect address, or null without a port', async () => {
    expect(await (await app().request('/api/mcp-servers/sign-in/redirect-uri')).json()).toEqual({ redirectUri: REDIRECT });
    expect(await (await app({}).request('/api/mcp-servers/sign-in/redirect-uri')).json()).toEqual({ redirectUri: null });
  });

  it('cancel drops the pending sign-in', async () => {
    const id = await createServer();
    await startSignIn(id);
    expect((await app().request(`/api/mcp-servers/${id}/sign-in/cancel`, { method: 'POST' })).status).toBe(204);
    expect(healthOf(id).auth).toMatchObject({ pending: false });
  });

  it('complete (paste-back) signs in from the pasted address; another server\'s state is refused without using it up', async () => {
    const id = await createServer();
    const other = await createServer('Other');
    const ended = await endedOn(await startSignIn(id));

    const wrong = await app().request(`/api/mcp-servers/${other}/sign-in/complete`, json({ url: ended.href }));
    expect(wrong.status).toBe(400);

    const res = await app().request(`/api/mcp-servers/${id}/sign-in/complete`, json({ url: ended.href }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: true });
    await waitFor(() => healthOf(id).status === 'ok');
    expect(healthOf(id).auth).toMatchObject({ state: 'signed_in', account: 'alice@example.com' });
  });

  it('complete refuses an address that is not one, or has no state', async () => {
    const id = await createServer();
    expect((await app().request(`/api/mcp-servers/${id}/sign-in/complete`, json({ url: 'not a url' }))).status).toBe(400);
    expect((await app().request(`/api/mcp-servers/${id}/sign-in/complete`, json({ url: `${REDIRECT}?code=x` }))).status).toBe(400);
    expect((await app().request(`/api/mcp-servers/${id}/sign-in/complete`, json({}))).status).toBe(400);
    expect((await app().request(`/api/mcp-servers/${id}/sign-in/complete`, json(null))).status).toBe(400);
  });

  it('sign-out forgets the sign-in and the server needs sign-in again', async () => {
    const id = await createServer();
    await app().request(callbackPath(await endedOn(await startSignIn(id))));
    await waitFor(() => healthOf(id).status === 'ok');

    expect((await app().request(`/api/mcp-servers/${id}/sign-out`, { method: 'POST' })).status).toBe(204);
    await waitFor(() => healthOf(id).status === 'needs_auth');
    expect(await secrets.get(oauthRefs(id).tokens)).toBeNull();
  });

  it('an unexpected error from the manager is logged by name only and shown as plain text, with no code or URL', async () => {
    const id = await createServer();
    const leaky = 'connect failed for https://idp.example/authorize?code=SECRETCODE&state=SECRETSTATE';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(mcpManager, 'startSignIn').mockRejectedValue(new TypeError(leaky));
    vi.spyOn(mcpManager, 'completeSignIn').mockRejectedValue(new TypeError(leaky));

    const start = await app().request(`/api/mcp-servers/${id}/sign-in`, { method: 'POST' });
    const complete = await app().request(`/api/mcp-servers/${id}/sign-in/complete`, json({ url: `${REDIRECT}?state=SECRETSTATE&code=SECRETCODE` }));
    for (const res of [start, complete]) {
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "Couldn't sign in: something went wrong in Grunt. Start it again." });
    }

    const logged = [...errorSpy.mock.calls, ...logSpy.mock.calls, ...warnSpy.mock.calls].map((args) => args.map(String).join(' ')).join('\n');
    expect(logged).toContain(`[grunt-server] MCP sign-in for ${id} failed: TypeError`);
    expect(logged).not.toMatch(/SECRET|idp\.example|connect failed/);
  });
});

describe('GET /oauth/callback', { timeout: 20_000 }, () => {
  it('finishes the sign-in with a plain, locked-down page naming the server, escaped', async () => {
    const id = await createServer('<b>Docs & Co</b>');
    const res = await app().request(callbackPath(await endedOn(await startSignIn(id))));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html).toContain('Signed in to &lt;b&gt;Docs &amp; Co&lt;/b&gt;. You can close this tab and go back to Grunt.');
    expect(html).not.toContain('<b>Docs');
    expect(html).not.toContain('<script');
    await waitFor(() => healthOf(id).status === 'ok');
  });

  it('a reloaded callback page is refused and leaves the sign-in alone', async () => {
    const id = await createServer();
    const path = callbackPath(await endedOn(await startSignIn(id)));
    expect((await app().request(path)).status).toBe(200);
    await waitFor(() => healthOf(id).status === 'ok');

    const again = await app().request(path);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('This sign-in has expired or was already used. Start it again from Grunt.');
    expect(healthOf(id)).toMatchObject({ status: 'ok', auth: { state: 'signed_in' } });
  });

  it('an unknown or missing state is a 400', async () => {
    expect((await app().request('/oauth/callback?state=nope&code=x')).status).toBe(400);
    expect((await app().request('/oauth/callback?code=x')).status).toBe(400);
  });

  it('a provider error shows only its sanitised code', async () => {
    const id = await createServer();
    const authorizationUrl = await startSignIn(id);
    const state = new URL(authorizationUrl).searchParams.get('state')!;
    const res = await app().request(`/oauth/callback?state=${encodeURIComponent(state)}&error=${encodeURIComponent('access_denied<script>alert(1)</script>')}`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('The sign-in provider said: access_deniedscriptalert1script');
    expect(html).not.toContain('<script');
    expect(healthOf(id).auth).toMatchObject({ error: 'The sign-in provider said: access_deniedscriptalert1script' });
  });

  it('needs no bearer token when the app has one, and a foreign Host still gets 421', async () => {
    const id = await createServer();
    const path = callbackPath(await endedOn(await startSignIn(id)));
    const guarded = app({ token: 'tok', oauthCallbackPort: () => PORT, hostCheckPort: () => PORT });
    expect((await guarded.request(path, { headers: { Host: 'evil.example:4747' } })).status).toBe(421);
    expect((await guarded.request(path, { headers: { Host: `127.0.0.1:${PORT}` } })).status).toBe(200);
  });

  it('a manager failure that is not a SignInError logs a fixed line and shows a fixed page', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(mcpManager, 'completeSignIn').mockRejectedValue(new Error('boom code=SECRETCODE'));
    const res = await app().request('/oauth/callback?state=s&code=SECRETCODE');
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('SECRETCODE');
    expect(errorSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n')).not.toContain('SECRETCODE');
  });
});

describe('what the browser can see', { timeout: 20_000 }, () => {
  it('health carries auth, and neither health nor the stored row nor the secrets file holds a token', async () => {
    const id = await createServer();
    await app().request(callbackPath(await endedOn(await startSignIn(id))));
    await waitFor(() => healthOf(id).status === 'ok');

    const list = await (await app().request('/api/mcp-servers')).text();
    const one = await (await app().request(`/api/mcp-servers/${id}`)).text();
    expect(JSON.parse(list)).toEqual([expect.objectContaining({ id, auth: expect.objectContaining({ state: 'signed_in', account: 'alice@example.com' }) })]);
    const file = readFileSync(join(dir, 'secrets.json'), 'utf8');
    for (const token of [...fixture.issued.accessTokens, ...fixture.issued.refreshTokens, ...fixture.issued.idTokens]) {
      expect(list).not.toContain(token);
      expect(one).not.toContain(token);
      expect(file).not.toContain(token); // encrypted at rest
    }
    expect(await secrets.get(oauthRefs(id).tokens)).toContain(fixture.issued.accessTokens[0]!);
  });
});

describe('Sign-in app fields', { timeout: 20_000 }, () => {
  it('POST stores the client secret by reference only, and GET never shows it', async () => {
    const id = await createServer('Manual', { oauthClientId: 'app-1', oauthClientSecret: 'super-secret-client-value' });
    const row = store.mcpServers.get(id)!;
    expect(row.oauth).toMatchObject({ clientId: 'app-1', clientSecretRef: oauthRefs(id).clientSecret });
    expect(await secrets.get(oauthRefs(id).clientSecret)).toBe('super-secret-client-value');
    const shown = await (await app().request(`/api/mcp-servers/${id}`)).text();
    expect(shown).not.toContain('super-secret-client-value');
    expect(shown).toContain(oauthRefs(id).clientSecret);
    const created = await (await app().request('/api/mcp-servers', json({ name: 'Again', transport: 'http', url: fixture.url, enabled: false, oauthClientId: 'app-2', oauthClientSecret: 'another-secret-value' }))).text();
    expect(created).not.toContain('another-secret-value');
  });

  it('PATCH: absent keeps the secret, null removes it, an empty client ID clears both; stdio is refused', async () => {
    const id = await createServer('Manual', { oauthClientId: 'app-1', oauthClientSecret: 'value-1' });
    const patch = (body: unknown) => app().request(`/api/mcp-servers/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    await patch({ name: 'Renamed' });
    expect(await secrets.get(oauthRefs(id).clientSecret)).toBe('value-1');
    await patch({ oauthClientSecret: null });
    expect(await secrets.get(oauthRefs(id).clientSecret)).toBeNull();
    expect(store.mcpServers.get(id)!.oauth).toMatchObject({ clientId: 'app-1', clientSecretRef: null });
    await patch({ oauthClientId: '' });
    expect(store.mcpServers.get(id)!.oauth).toBeNull();

    const secretWithoutId = await patch({ oauthClientSecret: 'orphan' });
    expect(secretWithoutId.status).toBe(400);
    expect(await secrets.get(oauthRefs(id).clientSecret)).toBeNull();

    const stdio = await app().request('/api/mcp-servers', json({ name: 'Local', transport: 'stdio', command: 'x', enabled: false, oauthClientId: 'app-1' }));
    expect(stdio.status).toBe(400);
    const stdioPatch = await patch({ transport: 'stdio', command: 'x', oauthClientId: 'app-1' });
    expect(stdioPatch.status).toBe(400);
    expect(store.mcpServers.get(id)!.transport).toBe('http');
  });

  it('PATCH: removing a secret that is not stored does not restart the connection', async () => {
    const id = await createServer('Manual', { oauthClientId: 'app-1' });
    const reconfigure = vi.spyOn(mcpManager, 'reconfigureHeld');
    const res = await app().request(`/api/mcp-servers/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oauthClientSecret: null }) });
    expect(res.status).toBe(200);
    expect(reconfigure).not.toHaveBeenCalled();
    expect(store.mcpServers.get(id)!.oauth).toMatchObject({ clientId: 'app-1', clientSecretRef: null });
  });

  it('PATCH: changing the client ID signs the server out and reconnects; sending the same one changes nothing', async () => {
    await fixture.close();
    fixture = await startOAuthEchoServer({ idTokenEmail: 'alice@example.com', staticClients: { 'app-1': null, 'app-2': null } });
    const id = await createServer('Manual', { oauthClientId: 'app-1' });
    const patch = (body: unknown) => app().request(`/api/mcp-servers/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await app().request(callbackPath(await endedOn(await startSignIn(id))));
    await waitFor(() => healthOf(id).status === 'ok');

    expect((await patch({ oauthClientId: 'app-1' })).status).toBe(200);
    expect(healthOf(id)).toMatchObject({ status: 'ok', auth: { state: 'signed_in' } });
    expect(await secrets.get(oauthRefs(id).tokens)).not.toBeNull();

    expect((await patch({ oauthClientId: 'app-2' })).status).toBe(200);
    expect(await secrets.get(oauthRefs(id).tokens)).toBeNull();
    expect(store.mcpServers.get(id)!.oauth).toMatchObject({ clientId: 'app-2', account: null, signedInAt: null });
    await waitFor(() => healthOf(id).status === 'needs_auth');
  });
});

describe('sign-in mode (remote access)', { timeout: 20_000 }, () => {
  let fx: RemoteFixture;
  afterEach(() => fx?.cleanup());

  const HOST = { Host: 'grunt.test:4747' };

  async function makeRemote() {
    fx = await remoteFixture();
    // The port the server bound is deliberately different from the public one: the redirect must use the public origin.
    const remoteApp = createApp(container, { remote: fx.remote, hostCheckPort: () => 9, oauthCallbackPort: () => 9 });
    const login = await remoteApp.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...HOST }, body: JSON.stringify({ password: PASSWORD }) }, from('10.0.0.7'));
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const request = (path: string, init: RequestInit = {}) =>
      remoteApp.request(path, { ...init, headers: { ...HOST, Cookie: cookie, ...((init.headers as Record<string, string>) ?? {}) } }, from('10.0.0.7'));
    return { remoteApp, request };
  }

  it('reports and uses the public origin as the redirect address', async () => {
    const { request } = await makeRemote();
    expect(await (await request('/api/mcp-servers/sign-in/redirect-uri')).json()).toEqual({ redirectUri: PUBLIC_REDIRECT });

    const id = await createServer();
    const res = await request(`/api/mcp-servers/${id}/sign-in`, { method: 'POST' });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { authorizationUrl: string }).authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(PUBLIC_REDIRECT);
  });

  it('keeps the sign-in routes behind the session, but the callback open', async () => {
    const { remoteApp, request } = await makeRemote();
    const id = await createServer();
    const noCookie = await remoteApp.request(`/api/mcp-servers/${id}/sign-in`, { method: 'POST', headers: HOST }, from('10.0.0.7'));
    expect(noCookie.status).toBe(401);

    const started = await request(`/api/mcp-servers/${id}/sign-in`, { method: 'POST' });
    const ended = await endedOn(((await started.json()) as { authorizationUrl: string }).authorizationUrl);
    expect(ended.origin).toBe('https://grunt.test:4747');

    // The system browser has no session cookie; it still reaches the callback, which passes the Host check.
    const foreign = await remoteApp.request(callbackPath(ended), { headers: { Host: 'evil.example:4747' } }, from('10.0.0.7'));
    expect(foreign.status).toBe(421);
    const res = await remoteApp.request(callbackPath(ended), { headers: HOST }, from('10.0.0.7'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBeNull();
    await waitFor(() => healthOf(id).status === 'ok');
  });

  it('also works with the bearer token when one is set', async () => {
    fx = await remoteFixture();
    const bearerApp = createApp(container, { remote: fx.remote, token: 'tok', hostCheckPort: () => 9 });
    const res = await bearerApp.request('/api/mcp-servers/sign-in/redirect-uri', { headers: { ...HOST, Authorization: 'Bearer tok' } }, from('10.0.0.7'));
    expect(await res.json()).toEqual({ redirectUri: PUBLIC_REDIRECT });
  });
});

describe('editing and deleting a signed-in server', { timeout: 20_000 }, () => {
  async function signedIn(name = 'Hosted Docs'): Promise<string> {
    const id = await createServer(name);
    await app().request(callbackPath(await endedOn(await startSignIn(id))));
    await waitFor(() => healthOf(id).status === 'ok');
    return id;
  }
  const patchJson = (body: unknown) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const liveClient = (id: string) => mcpManager.listFor([id])[0]?.client;

  it('saving without changes keeps the sign-in and the live connection', async () => {
    const id = await signedIn();
    const before = liveClient(id);
    const signedInAt = store.mcpServers.get(id)!.oauth!.signedInAt;
    // Exactly what the web form sends on Save: every field, unchanged.
    const res = await app().request(`/api/mcp-servers/${id}`, patchJson({ name: 'Hosted Docs', transport: 'http', command: null, args: [], url: fixture.url, enabled: true }));
    expect(res.status).toBe(200);
    expect(liveClient(id)).toBe(before);
    expect(store.mcpServers.get(id)!.oauth!.signedInAt).toBe(signedInAt);
    expect(await secrets.get(oauthRefs(id).tokens)).not.toBeNull();
  });

  it('a rename alone keeps the sign-in and the live connection', async () => {
    const id = await signedIn();
    const before = liveClient(id);
    await app().request(`/api/mcp-servers/${id}`, patchJson({ name: 'Renamed' }));
    expect(liveClient(id)).toBe(before);
    expect(healthOf(id).auth).toMatchObject({ state: 'signed_in' });
  });

  it('a URL change forgets the tokens and restarts against the new URL', async () => {
    const id = await signedIn();
    const second = await startOAuthEchoServer();
    try {
      const res = await app().request(`/api/mcp-servers/${id}`, patchJson({ url: second.url }));
      expect(res.status).toBe(200);
      expect(await secrets.get(oauthRefs(id).tokens)).toBeNull();
      expect(await secrets.get(oauthRefs(id).client)).toBeNull();
      await waitFor(() => healthOf(id).status === 'needs_auth');
      expect(second.mcpRequests()).toBeGreaterThan(0);
      expect(healthOf(id).auth).toMatchObject({ state: 'needs_sign_in', signedInAt: null });
    } finally {
      await second.close(); // the server is in needs_auth, so nothing retries against it
    }
  });

  it('switching to stdio forgets every OAuth secret and clears the summary', async () => {
    const id = await signedIn();
    const res = await app().request(`/api/mcp-servers/${id}`, patchJson({ transport: 'stdio', command: 'grunt-test-no-such-command', enabled: false }));
    expect(res.status).toBe(200);
    expect(store.mcpServers.get(id)!.oauth).toBeNull();
    for (const ref of Object.values(oauthRefs(id))) expect(await secrets.get(ref)).toBeNull();
  });

  it('DELETE removes every OAuth secret', async () => {
    const id = await signedIn();
    expect((await app().request(`/api/mcp-servers/${id}`, { method: 'DELETE' })).status).toBe(204);
    for (const ref of Object.values(oauthRefs(id))) expect(await secrets.get(ref)).toBeNull();
  });

  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const liveUrl = (id: string) => ((mcpManager as unknown as { clients: Map<string, { config: { url: string } }> }).clients.get(id))?.config.url;

  it('a URL change while a refresh against the old URL is in flight never sends the old tokens to the new URL', async () => {
    const id = await signedIn();
    const second = await startOAuthEchoServer();
    try {
      // A refresh against the first server, parked at its token endpoint.
      const release = fixture.holdRefreshes();
      fixture.expireAccessTokens();
      void mcpManager.refresh(id);
      await waitFor(() => fixture.refreshesParked() >= 1);

      const res = await app().request(`/api/mcp-servers/${id}`, patchJson({ url: second.url }));
      expect(res.status).toBe(200);
      await waitFor(() => healthOf(id).status === 'needs_auth');

      release(); // the old refresh now finishes, after the edit
      await waitFor(() => fixture.issued.accessTokens.length >= 2);
      await pause(200);

      expect(second.mcpRequests()).toBeGreaterThan(0);
      for (const header of second.mcpAuthHeaders) {
        expect(header).toBe('');
        for (const token of fixture.issued.accessTokens) expect(header).not.toContain(token);
      }
      // Nothing bound to the old URL is left for the new connection to use.
      expect(await secrets.get(oauthRefs(id).tokens)).toBeNull();
      expect(store.mcpServers.get(id)).toMatchObject({ url: second.url, oauth: null });
      expect(healthOf(id)).toMatchObject({ status: 'needs_auth', auth: { state: 'needs_sign_in' } });
    } finally {
      await second.close();
    }
  });

  it('two PATCHes at once leave the row, the live connection and the sign-in state consistent', async () => {
    const id = await signedIn();
    const b = await startOAuthEchoServer();
    const c = await startOAuthEchoServer();
    try {
      const [r1, r2] = await Promise.all([
        app().request(`/api/mcp-servers/${id}`, patchJson({ url: b.url })),
        app().request(`/api/mcp-servers/${id}`, patchJson({ url: c.url })),
      ]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      await waitFor(() => healthOf(id).status === 'needs_auth');
      await pause(300); // nothing else retries: needs_auth stops the reconnect loop

      const finalUrl = store.mcpServers.get(id)!.url;
      expect([b.url, c.url]).toContain(finalUrl);
      expect(liveUrl(id)).toBe(finalUrl);
      expect(store.mcpServers.get(id)!.oauth).toBeNull();
      expect(await secrets.get(oauthRefs(id).tokens)).toBeNull();
      expect(await secrets.get(oauthRefs(id).client)).toBeNull();
      for (const header of [...b.mcpAuthHeaders, ...c.mcpAuthHeaders]) expect(header).toBe('');
      // The loser's connection was stopped: only the final URL keeps being asked.
      const loser = finalUrl === b.url ? c : b;
      const seen = loser.mcpRequests();
      await pause(200);
      expect(loser.mcpRequests()).toBe(seen);
    } finally {
      await b.close();
      await c.close();
    }
  });

  it.each([
    ['the unchanged save first', 0],
    ['the URL change first', 1],
  ])('an unchanged-form save and a URL change sent together end consistent (%s)', async (_label, changeFirst) => {
    const id = await signedIn();
    const second = await startOAuthEchoServer();
    try {
      const unchangedForm = () => app().request(`/api/mcp-servers/${id}`, patchJson({ name: 'Hosted Docs', transport: 'http', command: null, args: [], url: fixture.url, enabled: true }));
      const urlChange = () => app().request(`/api/mcp-servers/${id}`, patchJson({ url: second.url }));
      const sends = changeFirst ? [urlChange, unchangedForm] : [unchangedForm, urlChange];
      const results = await Promise.all(sends.map((send) => send()));
      expect(results.map((r) => r.status)).toEqual([200, 200]);

      // Whichever the lock ran last decides the URL; the connection and the sign-in state must agree with it.
      await waitFor(() => healthOf(id).status === 'needs_auth');
      await pause(200);
      const finalUrl = store.mcpServers.get(id)!.url;
      expect([fixture.url, second.url]).toContain(finalUrl);
      expect(liveUrl(id)).toBe(finalUrl);
      expect(store.mcpServers.get(id)!.oauth).toBeNull();
      expect(await secrets.get(oauthRefs(id).tokens)).toBeNull();
      expect(healthOf(id)).toMatchObject({ status: 'needs_auth', auth: { state: 'needs_sign_in', signedInAt: null } });
      for (const header of second.mcpAuthHeaders) expect(header).toBe('');
    } finally {
      await second.close();
    }
  });

  it('a hand-registered client survives a URL change, while the tokens and the registered client go', async () => {
    const manualFx = await startOAuthEchoServer({ dcr: false, staticClients: { 'manual-1': 'manual-secret' }, idTokenEmail: 'alice@example.com' });
    try {
      const id = await createServer('Manual', { url: manualFx.url });
      await secrets.set(oauthRefs(id).clientSecret, 'manual-secret');
      store.mcpServers.update(id, { oauth: { clientId: 'manual-1', clientSecretRef: oauthRefs(id).clientSecret, account: null, signedInAt: null } });
      await app().request(callbackPath(await endedOn(await startSignIn(id))));
      await waitFor(() => healthOf(id).status === 'ok');
      expect(await secrets.get(oauthRefs(id).tokens)).not.toBeNull();

      const res = await app().request(`/api/mcp-servers/${id}`, patchJson({ url: fixture.url }));
      expect(res.status).toBe(200);
      expect(await secrets.get(oauthRefs(id).tokens)).toBeNull();
      expect(await secrets.get(oauthRefs(id).client)).toBeNull();
      expect(await secrets.get(oauthRefs(id).clientSecret)).toBe('manual-secret');
      expect(store.mcpServers.get(id)!.oauth).toEqual({ clientId: 'manual-1', clientSecretRef: oauthRefs(id).clientSecret, account: null, signedInAt: null });
      await waitFor(() => healthOf(id).status === 'needs_auth');
    } finally {
      await manualFx.close();
    }
  });

  it('a DELETE racing a sign-in that is saving its tokens waits for it, then leaves no OAuth secret', async () => {
    const id = await createServer();
    const ended = await endedOn(await startSignIn(id));

    // Hold the sign-in at the moment it writes its tokens.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const realSet = secrets.set.bind(secrets);
    vi.spyOn(secrets, 'set').mockImplementation(async (ref, value) => {
      if (ref === oauthRefs(id).tokens) {
        held = true;
        await gate;
      }
      await realSet(ref, value);
    });

    const callback = app().request(callbackPath(ended));
    await waitFor(() => held);
    const deleted = app().request(`/api/mcp-servers/${id}`, { method: 'DELETE' });
    await pause(100);
    expect(store.mcpServers.get(id)).not.toBeNull(); // the delete is queued behind the sign-in

    release();
    const [cb, del] = await Promise.all([callback, deleted]);
    expect(cb.status).toBe(200);
    expect(del.status).toBe(204);
    expect(store.mcpServers.get(id)).toBeNull();
    for (const ref of Object.values(oauthRefs(id))) expect(await secrets.get(ref)).toBeNull();
  });

  it('deleting a server mid sign-in removes every OAuth secret and refuses the late callback', async () => {
    const id = await createServer();
    const ended = await endedOn(await startSignIn(id));
    expect((await app().request(`/api/mcp-servers/${id}`, { method: 'DELETE' })).status).toBe(204);

    const late = await app().request(callbackPath(ended));
    expect(late.status).toBe(400);
    for (const ref of Object.values(oauthRefs(id))) expect(await secrets.get(ref)).toBeNull();
  });
});
