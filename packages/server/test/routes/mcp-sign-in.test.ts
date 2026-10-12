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

describe('MCP sign-in routes', () => {
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

describe('GET /oauth/callback', () => {
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

describe('what the browser can see', () => {
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

describe('sign-in mode (remote access)', () => {
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
