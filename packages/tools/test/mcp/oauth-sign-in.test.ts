import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { InMemoryStore, FakeSecretStore } from '@grunt/core/testing/fakes.js';
import type { McpServer } from '@grunt/core/ports/store.js';
import { McpServerManager } from '../../src/mcp/manager.js';
import { oauthRefs } from '../../src/mcp/oauth-store.js';
import { SignInError, checkAuthorizationUrl, redactMessage, sanitiseErrorCode } from '../../src/mcp/sign-in.js';
import { looksSecret } from '../../src/mcp/redact.js';
import { serveHttp } from '../fixtures/echo-server.js';
import { startOAuthEchoServer } from '../fixtures/oauth-echo-server.js';

const REDIRECT = 'http://127.0.0.1:4747/oauth/callback';
const OTHER_REDIRECT = 'http://127.0.0.1:5858/oauth/callback';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  await vi.waitFor(() => {
    if (!predicate()) throw new Error('condition not met yet');
  }, { timeout: timeoutMs, interval: 25 });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function httpRow(url: string, over: Partial<McpServer> = {}): McpServer {
  return { id: 'srv-1', name: 'Hosted Docs', transport: 'http', command: null, args: [], envRefs: {}, url, headerRefs: {}, enabled: true, status: 'unknown', toolsCache: null, oauth: null, ...over };
}

async function setup(fixtureOpts: Record<string, unknown> = {}, rowOver: Partial<McpServer> = {}) {
  const fixture = await startOAuthEchoServer(fixtureOpts);
  cleanups.push(() => fixture.close());
  const store = new InMemoryStore();
  const secrets = new FakeSecretStore();
  const clock = { t: Date.now() };
  store.mcpServers.create(httpRow(fixture.url, rowOver));
  const manager = new McpServerManager(store, secrets, { initialBackoffMs: 50, maxBackoffMs: 100 }, { now: () => clock.t });
  cleanups.push(() => manager.shutdown());
  await manager.sync();
  // Let the background connect settle first, so it never races the sign-in a test starts.
  await waitFor(() => manager.health()[0]?.status === 'needs_auth');
  return { fixture, store, secrets, clock, manager };
}

/** Follows the authorization URL the way a browser would, stopping at the redirect back to Grunt. */
async function followAuthorization(authorizationUrl: string): Promise<{ state: string; code?: string; error?: string }> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error(`no redirect (HTTP ${res.status}): ${await res.text()}`);
  const q = new URL(location).searchParams;
  return { state: q.get('state')!, code: q.get('code') ?? undefined, error: q.get('error') ?? undefined };
}

async function signIn(manager: McpServerManager, redirectUri = REDIRECT): Promise<void> {
  const { authorizationUrl } = await manager.startSignIn('srv-1', redirectUri);
  await manager.completeSignIn(await followAuthorization(authorizationUrl));
}

const health = (manager: McpServerManager) => manager.health()[0]!;

describe('signing in', { timeout: 20_000 }, () => {
  it('start returns an authorization URL with S256, state, the redirect address and resource, and registers one client', async () => {
    const { fixture, manager } = await setup();
    await waitFor(() => health(manager).status === 'needs_auth');

    const { authorizationUrl } = await manager.startSignIn('srv-1', REDIRECT);
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe(fixture.origin);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('resource')).toBe(fixture.url);
    expect(fixture.registrations).toHaveLength(1);
    expect(fixture.registrations[0]!.metadata).toMatchObject({
      client_name: 'Grunt',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(health(manager).auth).toMatchObject({ pending: true });
  });

  it('completing it connects the server, lists and calls its tools, and keeps no token in the row', async () => {
    const { fixture, store, secrets, manager } = await setup({ idTokenEmail: 'alice@example.com' });
    await signIn(manager);

    expect(health(manager)).toMatchObject({ status: 'ok', toolCount: 2, auth: { state: 'signed_in', account: 'alice@example.com', pending: false, error: null } });
    const listed = manager.listFor(['srv-1']);
    expect(listed[0]!.client.tools.map((t) => t.name).sort()).toEqual(['crash', 'echo']);
    const result = await listed[0]!.client.callTool('echo', { text: 'signed-in' });
    expect(JSON.stringify(result.content)).toContain('signed-in');

    const rowJson = JSON.stringify(store.mcpServers.get('srv-1'));
    for (const token of [...fixture.issued.accessTokens, ...fixture.issued.refreshTokens, ...fixture.issued.idTokens]) expect(rowJson).not.toContain(token);
    expect(await secrets.get(oauthRefs('srv-1').tokens)).toContain(fixture.issued.accessTokens[0]!);
  });

  it('an expired access token is refreshed on the next call, and the rotated refresh token is stored', async () => {
    const { fixture, secrets, manager } = await setup({ rotate: true });
    await signIn(manager);
    fixture.expireAccessTokens();

    const result = await manager.listFor(['srv-1'])[0]!.client.callTool('echo', { text: 'after-expiry' });
    expect(JSON.stringify(result.content)).toContain('after-expiry');
    const stored = JSON.parse((await secrets.get(oauthRefs('srv-1').tokens))!) as { tokens: { refresh_token: string } };
    expect(fixture.issued.refreshTokens).toHaveLength(2);
    expect(stored.tokens.refresh_token).toBe(fixture.issued.refreshTokens[1]);
  });

  it('two calls racing after expiry both succeed through rotating refresh tokens, and the server stays signed in', async () => {
    const { fixture, manager, clock } = await setup({ rotate: true });
    await signIn(manager);
    clock.t += 2 * 60 * 60_000; // the sign-in itself is long past the 60-second grace
    fixture.expireAccessTokens();

    const client = manager.listFor(['srv-1'])[0]!.client;
    const [a, b] = await Promise.all([client.callTool('echo', { text: 'race-a' }), client.callTool('echo', { text: 'race-b' })]);
    expect(JSON.stringify(a.content)).toContain('race-a');
    expect(JSON.stringify(b.content)).toContain('race-b');
    expect(health(manager)).toMatchObject({ status: 'ok', auth: { state: 'signed_in' } });
  });

  it('a revoked refresh token ends in needs_auth with the sign-in forgotten', async () => {
    const { fixture, store, secrets, manager, clock } = await setup();
    await signIn(manager);
    clock.t += 2 * 60 * 60_000;
    fixture.revokeRefreshTokens();
    fixture.expireAccessTokens();

    await expect(manager.listFor(['srv-1'])[0]!.client.callTool('echo', { text: 'x' })).rejects.toThrow();
    await waitFor(() => health(manager).status === 'needs_auth');
    expect(health(manager).auth).toMatchObject({ state: 'needs_sign_in', signedInAt: null });
    expect(store.mcpServers.get('srv-1')!.oauth?.signedInAt ?? null).toBeNull();
    expect(await secrets.get(oauthRefs('srv-1').tokens)).toBeNull();
  });

  it('a token endpoint that is down is an ordinary error, keeps the sign-in and recovers', async () => {
    const { fixture, secrets, manager } = await setup();
    await signIn(manager);
    fixture.setTokenDown(true);
    fixture.expireAccessTokens();

    await expect(manager.listFor(['srv-1'])[0]!.client.callTool('echo', { text: 'x' })).rejects.toThrow();
    await waitFor(() => health(manager).status === 'error');
    expect(health(manager).lastError).toContain("Couldn't refresh the sign-in; will retry.");
    expect(health(manager).auth).toMatchObject({ state: 'signed_in' });
    expect(await secrets.get(oauthRefs('srv-1').tokens)).not.toBeNull();

    fixture.setTokenDown(false);
    await waitFor(() => health(manager).status === 'ok'); // the backoff reconnect refreshes and gets back in
  });

  it('a second start with the same redirect address reuses the registration and replaces the first flow; a new address registers again', async () => {
    const { fixture, manager } = await setup();
    const first = await manager.startSignIn('srv-1', REDIRECT);
    const second = await manager.startSignIn('srv-1', REDIRECT);
    expect(fixture.registrations).toHaveLength(1);

    const stale = await followAuthorization(first.authorizationUrl);
    await expect(manager.completeSignIn(stale)).rejects.toMatchObject({ status: 400, message: 'This sign-in has expired or was already used. Start it again from Grunt.' });
    expect(new URL(second.authorizationUrl).searchParams.get('state')).not.toBe(stale.state);

    await manager.startSignIn('srv-1', OTHER_REDIRECT);
    expect(fixture.registrations).toHaveLength(2);
  });

  it('completion refuses an unknown state, a reused state and one older than 10 minutes', async () => {
    const { manager, clock } = await setup();
    await expect(manager.completeSignIn({ state: 'no-such-state', code: 'x' })).rejects.toBeInstanceOf(SignInError);

    const { authorizationUrl } = await manager.startSignIn('srv-1', REDIRECT);
    const back = await followAuthorization(authorizationUrl);
    await manager.completeSignIn(back);
    await expect(manager.completeSignIn(back)).rejects.toMatchObject({ status: 400 });
    expect(health(manager).auth).toMatchObject({ state: 'signed_in' }); // a reload of the callback leaves the sign-in alone

    const late = await manager.startSignIn('srv-1', REDIRECT);
    const lateBack = await followAuthorization(late.authorizationUrl);
    clock.t += 10 * 60_000 + 1;
    await expect(manager.completeSignIn(lateBack)).rejects.toMatchObject({ status: 400 });
    expect(health(manager).auth).toMatchObject({ pending: false });
  });

  it('a refusal at the provider is recorded as the last error until the next start', async () => {
    const { fixture, manager } = await setup();
    fixture.setDeny(true);
    const { authorizationUrl } = await manager.startSignIn('srv-1', REDIRECT);
    await expect(manager.completeSignIn(await followAuthorization(authorizationUrl))).rejects.toMatchObject({
      status: 400,
      message: 'The sign-in provider said: access_denied',
    });
    expect(health(manager).auth).toMatchObject({ error: 'The sign-in provider said: access_denied', pending: false });

    fixture.setDeny(false);
    await manager.startSignIn('srv-1', REDIRECT);
    expect(health(manager).auth).toMatchObject({ error: null, pending: true });
  });

  it('cancel drops the pending flow', async () => {
    const { manager } = await setup();
    const { authorizationUrl } = await manager.startSignIn('srv-1', REDIRECT);
    manager.cancelSignIn('srv-1');
    expect(health(manager).auth).toMatchObject({ pending: false });
    await expect(manager.completeSignIn(await followAuthorization(authorizationUrl))).rejects.toMatchObject({ status: 400 });
  });

  it('start is refused for a fixed Authorization header (any case), an unknown server, and a server that never asks', async () => {
    const { manager, store, secrets } = await setup();
    await secrets.set('ref-auth', 'Bearer fixed');
    store.mcpServers.update('srv-1', { headerRefs: { authorization: 'ref-auth' } });
    await expect(manager.startSignIn('srv-1', REDIRECT)).rejects.toMatchObject({
      status: 409,
      message: 'This server sends a fixed Authorization header. Remove it to sign in with a browser instead.',
    });
    await expect(manager.startSignIn('no-such-server', REDIRECT)).rejects.toMatchObject({ status: 404 });

    const plain = await serveHttp(0);
    cleanups.push(() => new Promise<void>((resolve) => { plain.closeAllConnections(); plain.close(() => resolve()); }));
    store.mcpServers.create(httpRow(`http://127.0.0.1:${(plain.address() as AddressInfo).port}/mcp`, { id: 'plain', name: 'Plain' }));
    await expect(manager.startSignIn('plain', REDIRECT)).rejects.toMatchObject({ status: 409, message: "This server didn't ask for a sign-in." });
  });

  it('with no dynamic registration, start explains how to register Grunt by hand', async () => {
    const { manager } = await setup({ dcr: false });
    await expect(manager.startSignIn('srv-1', REDIRECT)).rejects.toMatchObject({
      status: 502,
      message: `This server's sign-in provider doesn't let apps register themselves. Register Grunt with it (redirect address: ${REDIRECT}) and enter the client ID under Sign-in app.`,
    });
  });

  it('sign out deletes the secrets, clears the summary and leaves the server needing sign-in', async () => {
    const { store, secrets, manager } = await setup({ idTokenEmail: 'alice@example.com' });
    await signIn(manager);
    await manager.signOut('srv-1');

    expect(await secrets.get(oauthRefs('srv-1').tokens)).toBeNull();
    expect(await secrets.get(oauthRefs('srv-1').client)).toBeNull();
    expect(store.mcpServers.get('srv-1')!.oauth).toBeNull();
    await waitFor(() => health(manager).status === 'needs_auth');
    expect(health(manager).auth).toMatchObject({ state: 'needs_sign_in', account: null, signedInAt: null });
  });
});

describe('a background refresh still in flight', { timeout: 20_000 }, () => {
  /** Parks a refresh on the fixture: expires the access token, reconnects, and waits until the refresh_token grant is held. */
  async function parkRefresh(fixture: Awaited<ReturnType<typeof startOAuthEchoServer>>, manager: McpServerManager): Promise<() => Promise<void>> {
    const release = fixture.holdRefreshes();
    const parkedBefore = fixture.refreshesParked();
    fixture.expireAccessTokens();
    void manager.refresh('srv-1');
    await waitFor(() => fixture.refreshesParked() > parkedBefore);
    return async () => {
      const finishedBefore = fixture.refreshesFinished();
      release();
      await waitFor(() => fixture.refreshesFinished() > finishedBefore);
      await sleep(300); // the SDK reads the answer and calls saveTokens
    };
  }

  it('a sign-out while it is parked leaves no tokens behind, also after a relaunch', async () => {
    const { fixture, store, secrets, manager } = await setup({ idTokenEmail: 'alice@example.com' });
    await signIn(manager);
    const finish = await parkRefresh(fixture, manager);

    await manager.signOut('srv-1');
    await finish();

    expect(await secrets.get(oauthRefs('srv-1').tokens)).toBeNull();
    expect(store.mcpServers.get('srv-1')!.oauth).toBeNull();
    await waitFor(() => health(manager).status === 'needs_auth');

    await manager.shutdown();
    const relaunched = new McpServerManager(store, secrets, { initialBackoffMs: 50, maxBackoffMs: 100 });
    cleanups.push(() => relaunched.shutdown());
    await relaunched.sync();
    await waitFor(() => relaunched.health()[0]!.status === 'needs_auth');
    expect(relaunched.health()[0]!.auth).toMatchObject({ state: 'needs_sign_in' });
  });

  it('a new sign-in completed while it is parked keeps its own tokens', async () => {
    const { fixture, secrets, manager, clock } = await setup({ rotate: true });
    await signIn(manager);
    clock.t += 2 * 60 * 60_000;
    const finish = await parkRefresh(fixture, manager);

    await signIn(manager);
    const signedInWith = fixture.issued.accessTokens.at(-1)!;
    await waitFor(() => health(manager).status === 'ok');
    await finish();

    const stored = JSON.parse((await secrets.get(oauthRefs('srv-1').tokens))!) as { tokens: { access_token: string } };
    expect(stored.tokens.access_token).toBe(signedInWith);
    expect(health(manager)).toMatchObject({ status: 'ok', auth: { state: 'signed_in' } });
  });
});

describe('registrations', { timeout: 20_000 }, () => {
  it('"Sign in again" from a new redirect address that is cancelled keeps the registration the tokens belong to', async () => {
    const { fixture, secrets, manager, clock } = await setup({ rotate: true });
    await signIn(manager, REDIRECT);
    const original = fixture.registrations[0]!.clientId;

    await manager.startSignIn('srv-1', OTHER_REDIRECT); // the desktop app relaunched on another port
    expect(fixture.registrations).toHaveLength(2);
    manager.cancelSignIn('srv-1');
    const stored = JSON.parse((await secrets.get(oauthRefs('srv-1').client))!) as { info: { client_id: string } };
    expect(stored.info.client_id).toBe(original);

    clock.t += 2 * 60 * 60_000;
    fixture.expireAccessTokens();
    const result = await manager.listFor(['srv-1'])[0]!.client.callTool('echo', { text: 'still-signed-in' });
    expect(JSON.stringify(result.content)).toContain('still-signed-in');
    expect(health(manager)).toMatchObject({ status: 'ok', auth: { state: 'signed_in' } });
  });

  it('a new registration is saved, with the issuer, only when its sign-in completes', async () => {
    const { fixture, secrets, manager } = await setup();
    const { authorizationUrl } = await manager.startSignIn('srv-1', REDIRECT);
    expect(await secrets.get(oauthRefs('srv-1').client)).toBeNull();

    await manager.completeSignIn(await followAuthorization(authorizationUrl));
    const stored = JSON.parse((await secrets.get(oauthRefs('srv-1').client))!) as { redirectUri: string; issuer: string; info: { client_id: string } };
    expect(stored).toMatchObject({ redirectUri: REDIRECT, issuer: fixture.origin, info: { client_id: fixture.registrations[0]!.clientId } });
  });
});

describe('configured headers', { timeout: 20_000 }, () => {
  it('reach the MCP server, but never an authorization server on another origin (discovery, registration, token)', async () => {
    const fixture = await startOAuthEchoServer({ separateAuthServer: true, rotate: true });
    cleanups.push(() => fixture.close());
    const store = new InMemoryStore();
    const secrets = new FakeSecretStore();
    await secrets.set('ref-key', 'key-1234567890');
    store.mcpServers.create(httpRow(fixture.url, { headerRefs: { 'X-Api-Key': 'ref-key' } }));
    const manager = new McpServerManager(store, secrets, { initialBackoffMs: 50, maxBackoffMs: 100 });
    cleanups.push(() => manager.shutdown());
    await manager.sync();
    await waitFor(() => health(manager).status === 'needs_auth');

    await signIn(manager);
    fixture.expireAccessTokens();
    await manager.listFor(['srv-1'])[0]!.client.callTool('echo', { text: 'after-refresh' }); // a background refresh

    const toMcp = fixture.requestLog.filter((r) => r.server === 'mcp' && r.path === '/mcp');
    const toAuth = fixture.requestLog.filter((r) => r.server === 'auth');
    expect(toMcp.length).toBeGreaterThan(0);
    for (const r of toMcp) expect(r.headers['x-api-key']).toBe('key-1234567890');
    expect(new Set(toAuth.map((r) => r.path))).toEqual(new Set(['/.well-known/oauth-authorization-server', '/register', '/authorize', '/token']));
    expect(toAuth.filter((r) => r.path === '/token')).toHaveLength(2); // the code exchange and the refresh
    for (const r of toAuth) expect(r.headers['x-api-key']).toBeUndefined();
  });
});

describe('sign-in helpers', () => {
  it('sanitiseErrorCode keeps [A-Za-z0-9_.-] and at most 64 characters', () => {
    expect(sanitiseErrorCode('access_denied<script>alert(1)</script>')).toBe('access_deniedscriptalert1script');
    expect(sanitiseErrorCode('x'.repeat(100))).toHaveLength(64);
  });

  it('checkAuthorizationUrl accepts https and loopback http, and refuses anything else', () => {
    expect(() => checkAuthorizationUrl(new URL('https://auth.example.com/authorize'))).not.toThrow();
    expect(() => checkAuthorizationUrl(new URL('http://127.0.0.1:9000/authorize'))).not.toThrow();
    expect(() => checkAuthorizationUrl(new URL('http://localhost:9000/authorize'))).not.toThrow();
    expect(() => checkAuthorizationUrl(new URL('http://[::1]:9000/authorize'))).not.toThrow();
    expect(() => checkAuthorizationUrl(new URL('http://auth.example.com/authorize'))).toThrow(SignInError);
    expect(() => checkAuthorizationUrl(new URL('javascript:alert(1)'))).toThrow(SignInError);
  });
});

describe('one sign-in per server', { timeout: 20_000 }, () => {
  it('two starts fired together leave exactly one flow: the earlier one is refused, the later one completes', async () => {
    const { fixture, secrets, manager } = await setup();
    const [first, second] = await Promise.allSettled([manager.startSignIn('srv-1', REDIRECT), manager.startSignIn('srv-1', REDIRECT)]);

    expect(first.status).toBe('rejected');
    expect((first as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(second.status).toBe('fulfilled');
    expect(health(manager).auth).toMatchObject({ pending: true });
    // Starts run one after another: one registration, held until the sign-in completes, then stored.
    expect(fixture.registrations).toHaveLength(1);
    expect(await secrets.get(oauthRefs('srv-1').client)).toBeNull();

    await manager.completeSignIn(await followAuthorization((second as PromiseFulfilledResult<{ authorizationUrl: string }>).value.authorizationUrl));
    expect(health(manager)).toMatchObject({ status: 'ok', auth: { state: 'signed_in', pending: false } }); // no second flow was left waiting
    const stored = JSON.parse((await secrets.get(oauthRefs('srv-1').client))!) as { info: { client_id: string } };
    expect(stored.info.client_id).toBe(fixture.registrations[0]!.clientId);
  });

  it('a cancel while a start is still connecting stores no flow', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fixture, manager } = await setup({ registerGate: gate });
    const outcome = manager.startSignIn('srv-1', REDIRECT).then(() => null, (err: unknown) => err);
    await waitFor(() => fixture.registerRequests() > 0); // the start is now waiting on the provider
    manager.cancelSignIn('srv-1');
    release();

    expect(await outcome).toMatchObject({ status: 409 });
    expect(health(manager).auth).toMatchObject({ pending: false });
  });

  it('a sign-out while a start is still connecting stores no flow either', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fixture, manager } = await setup({ registerGate: gate });
    const outcome = manager.startSignIn('srv-1', REDIRECT).then(() => null, (err: unknown) => err);
    await waitFor(() => fixture.registerRequests() > 0);
    await manager.signOut('srv-1');
    release();

    expect(await outcome).toMatchObject({ status: 409 });
    expect(health(manager).auth).toMatchObject({ pending: false });
  });

  it('with no dynamic registration, a hand-registered client ID and secret sign in (the secret checked by the provider)', async () => {
    const { fixture, store, secrets, manager } = await setup({ dcr: false, staticClients: { 'grunt-manual': 'manual-secret' } });
    await expect(manager.startSignIn('srv-1', REDIRECT)).rejects.toMatchObject({ status: 502 });

    expect(await manager.setSignInApp('srv-1', 'grunt-manual', 'manual-secret')).toBe(true);
    expect(store.mcpServers.get('srv-1')!.oauth).toEqual({ clientId: 'grunt-manual', clientSecretRef: oauthRefs('srv-1').clientSecret, account: null, signedInAt: null });
    expect(await secrets.get(oauthRefs('srv-1').clientSecret)).toBe('manual-secret');

    await signIn(manager);
    expect(health(manager)).toMatchObject({ status: 'ok', auth: { state: 'signed_in' } });
    expect(fixture.registrations).toEqual([]);
  });

  it('a wrong hand-registered secret fails to finish, and changing the client ID forgets the sign-in', async () => {
    const { secrets, manager } = await setup({ dcr: false, staticClients: { 'grunt-manual': 'manual-secret', 'other-app': null } });
    await manager.setSignInApp('srv-1', 'grunt-manual', 'wrong-secret');
    const { authorizationUrl } = await manager.startSignIn('srv-1', REDIRECT);
    await expect(manager.completeSignIn(await followAuthorization(authorizationUrl))).rejects.toMatchObject({ status: 502 });

    await manager.setSignInApp('srv-1', 'grunt-manual', 'manual-secret');
    await signIn(manager);
    expect(await secrets.get(oauthRefs('srv-1').tokens)).not.toBeNull();

    expect(await manager.setSignInApp('srv-1', 'other-app', undefined)).toBe(true);
    expect(await secrets.get(oauthRefs('srv-1').tokens)).toBeNull();
    expect(await manager.setSignInApp('srv-1', 'other-app', undefined)).toBe(false); // nothing changed
  });

  it('clearing the client ID deletes its secret too', async () => {
    const { store, secrets, manager } = await setup();
    await manager.setSignInApp('srv-1', 'app-1', 's3cret');
    await manager.setSignInApp('srv-1', null, undefined);
    expect(store.mcpServers.get('srv-1')!.oauth).toBeNull();
    expect(await secrets.get(oauthRefs('srv-1').clientSecret)).toBeNull();
  });
});

describe('keeping codes, verifiers and tokens out of every message', { timeout: 20_000 }, () => {
  const OUTPUT_CHANNELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

  function captureConsole(): { text: () => string } {
    const lines: string[] = [];
    for (const channel of OUTPUT_CHANNELS) {
      vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
    return { text: () => lines.join('\n') };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a token endpoint that repeats the request back leaks nothing into the error, the health or the console', async () => {
    const MANUAL_SECRET = 'manual-secret-value';
    const { fixture, secrets, manager } = await setup(
      { tokenEcho: true, staticClients: { 'manual-id': MANUAL_SECRET } },
      { oauth: { clientId: 'manual-id', clientSecretRef: 'ref-manual-secret', account: null, signedInAt: null } }
    );
    await secrets.set('ref-manual-secret', MANUAL_SECRET);
    const output = captureConsole();

    const { authorizationUrl } = await manager.startSignIn('srv-1', REDIRECT);
    const back = await followAuthorization(authorizationUrl);
    const err = await manager.completeSignIn(back).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(SignInError);
    const verifier = fixture.tokenRequests.at(-1)!.code_verifier!;
    expect(verifier.length).toBeGreaterThan(20);
    // The manual client authenticated with client_secret_basic, and the provider echoed that header back first.
    const header = fixture.tokenAuthHeaders.at(-1)!;
    expect(header).toMatch(/^Basic /);
    const basicBase64 = header.slice('Basic '.length);
    expect(Buffer.from(basicBase64, 'base64').toString('utf8')).toBe(`manual-id:${MANUAL_SECRET}`);
    const shown = [(err as SignInError).message, health(manager).auth?.error ?? '', output.text()];
    expect((err as SignInError).message).toContain('[redacted]'); // the provider's echo did reach the SDK's error, and was cleaned
    for (const text of shown) {
      for (const secret of [back.code!, back.state, verifier, MANUAL_SECRET, basicBase64]) expect(text).not.toContain(secret);
    }
    expect((err as SignInError).message.length).toBeLessThan(400);
  });

  it('a whole successful sign-in and refresh writes no code, state, verifier or token to the console', async () => {
    const { fixture, manager } = await setup({ rotate: true, idTokenEmail: 'alice@example.com' });
    const output = captureConsole();

    const { authorizationUrl } = await manager.startSignIn('srv-1', REDIRECT);
    const back = await followAuthorization(authorizationUrl);
    await manager.completeSignIn(back);
    fixture.expireAccessTokens();
    await manager.listFor(['srv-1'])[0]!.client.callTool('echo', { text: 'x' });

    const verifier = fixture.tokenRequests[0]!.code_verifier!;
    const everything = [...fixture.issued.accessTokens, ...fixture.issued.refreshTokens, ...fixture.issued.idTokens, back.code!, back.state, verifier];
    expect(fixture.issued.accessTokens.length).toBeGreaterThan(1);
    for (const secret of everything) expect(output.text()).not.toContain(secret);
  });

  it('a start failure whose message holds a URL with a query shows the URL without it', async () => {
    const { manager } = await setup({ registerError: 'upstream failed at http://127.0.0.1:9/cb?code=abc123xyz&token=tok-999#frag-777 sorry' });
    const err = await manager.startSignIn('srv-1', REDIRECT).then(() => null, (e: unknown) => e);

    expect(err).toMatchObject({ status: 502 });
    const message = (err as SignInError).message;
    expect(message).toContain('http://127.0.0.1:9/cb');
    for (const leaked of ['abc123xyz', 'tok-999', 'frag-777', '?code']) expect(message).not.toContain(leaked);
  });

  it('a background connect error that echoes the access token reaches health redacted', async () => {
    const { fixture, manager } = await setup();
    await signIn(manager);
    const token = fixture.issued.accessTokens[0]!;
    fixture.setMcpFailure(true);

    await manager.refresh('srv-1'); // reconnect: the server now answers 500, repeating the credential it was sent
    await waitFor(() => health(manager).status === 'error');
    const lastError = health(manager).lastError!;
    expect(lastError).toContain('[redacted]');
    expect(lastError).not.toContain(token);
    expect(lastError).not.toMatch(/Bearer\s+at-/);
  });

  it('a failing tool call is redacted like lastError', async () => {
    const { fixture, manager } = await setup();
    await signIn(manager);
    const token = fixture.issued.accessTokens[0]!;
    const client = manager.listFor(['srv-1'])[0]!.client;
    fixture.setMcpFailure(true); // the server now answers 500, repeating the credential it was sent

    const err = await client.callTool('echo', { text: 'x' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[redacted]');
    expect((err as Error).message).not.toContain(token);
  });

  it('sign-out and forgetting a sign-in clear the last error', async () => {
    const { fixture, manager } = await setup();
    fixture.setDeny(true);
    const failed = async () => {
      const { authorizationUrl } = await manager.startSignIn('srv-1', REDIRECT);
      await manager.completeSignIn(await followAuthorization(authorizationUrl)).catch(() => {});
    };
    await failed();
    expect(health(manager).auth?.error).not.toBeNull();
    await manager.signOut('srv-1');
    expect(health(manager).auth?.error).toBeNull();

    await failed();
    expect(health(manager).auth?.error).not.toBeNull();
    await manager.forgetSignIn('srv-1', { keepManualClient: true });
    expect(health(manager).auth?.error).toBeNull();
  });
});

describe('redactMessage', () => {
  it('replaces known secrets (also URL-encoded), key=value pairs and JSON pairs', () => {
    const out = redactMessage('bad: code=abc.def&state=xyz and {"access_token":"tok-1","refresh_token": "rt-2"} verifier verifier-value-123 enc a%20b%26c tiny', ['verifier-value-123', 'a b&c', 'tin']);
    expect(out).not.toMatch(/abc\.def|xyz|tok-1|rt-2|verifier-value-123|a%20b%26c/);
    expect(out).toContain('[redacted]');
    expect(out).toContain('tiny'); // too short to count as a secret: left alone
  });

  it('redacts Bearer and Basic credentials', () => {
    const out = redactMessage('sent Authorization: Bearer abc.DEF-123_x~y+z/== then basic dXNlcjpwYXNz and Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==');
    expect(out).not.toMatch(/abc\.DEF|dXNlcjpwYXNz|QWxhZGRpbjpvcGVu/);
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('Basic [redacted]');
  });

  it('redacts authorization_code, client_assertion, token and password pairs, in URLs and outside them', () => {
    const out = redactMessage('authorization_code=ac-111 client_assertion=ca-222 token: tk-333 {"password":"pw-444"} at https://x.example/p?token=tk-555&password=pw-666');
    expect(out).not.toMatch(/ac-111|ca-222|tk-333|pw-444|tk-555|pw-666/);
    expect(out).toContain('https://x.example/p');
  });

  it('strips userinfo from URLs', () => {
    expect(redactMessage('failed https://user:pa55word@host.example/path?q=1 and http://tok@h2.example/')).toBe('failed https://host.example/path and http://h2.example/');
  });

  it('matches secrets form-encoded, percent-encoded and as base64 (also the client_id:secret Basic payload)', () => {
    const secret = 'se cret/+&=';
    const form = new URLSearchParams({ v: secret }).toString().slice(2);
    const b64 = Buffer.from(`my-client:${secret}`).toString('base64');
    const out = redactMessage(`a ${secret} b ${encodeURIComponent(secret)} c ${form} d ${b64} e`, [secret, `my-client:${secret}`]);
    for (const form2 of [secret, encodeURIComponent(secret), form, b64]) expect(out).not.toContain(form2);
    expect(out.match(/\[redacted\]/g)).toHaveLength(4);
  });

  it('keeps a purely numeric code or state ("exit code: 127"), and still redacts any other', () => {
    expect(redactMessage('server exited, exit code: 127; code=2 "state": "3"')).toBe('server exited, exit code: 127; code=2 "state": "3"');
    expect(redactMessage('code=abc123 state=12ab')).toBe('code=[redacted] state=[redacted]');
  });

  it('looksSecret: short values and letters-only words are not secrets; anything longer with a digit or symbol is', () => {
    for (const ordinary of ['production', 'Development', 'true', 'info', '127', 'debug']) expect(looksSecret(ordinary)).toBe(false);
    for (const secret of ['k3y-1234567890', 'sk_live_abcdef', 'Bearer abc123', '12345678']) expect(looksSecret(secret)).toBe(true);
  });

  it('drops the query and fragment of every URL, collapses whitespace and caps the length', () => {
    expect(redactMessage('see https://a.example/x/y?z=1#f and\n\n  http://b.example/?q=2')).toBe('see https://a.example/x/y and http://b.example/');
    const long = redactMessage('x'.repeat(1000));
    expect(long.length).toBeLessThanOrEqual(303);
    expect(long.endsWith('...')).toBe(true);
  });
});
