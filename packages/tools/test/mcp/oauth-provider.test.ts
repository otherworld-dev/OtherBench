import { describe, it, expect } from 'vitest';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryStore, FakeSecretStore } from '@grunt/core/testing/fakes.js';
import type { McpServer } from '@grunt/core/ports/store.js';
import { McpOAuthStore, oauthRefs } from '../../src/mcp/oauth-store.js';
import {
  BACKGROUND_REDIRECT_URI,
  GruntOAuthProvider,
  McpSignInRequiredError,
  accountFromIdToken,
  clientMetadataFor,
  hasAuthorizationHeader,
  isSignInRequired,
} from '../../src/mcp/oauth-provider.js';

const REDIRECT = 'http://127.0.0.1:4747/oauth/callback';
const TOKENS = { access_token: 'at-1', token_type: 'Bearer', refresh_token: 'rt-1' };

function makeRow(over: Partial<McpServer> = {}): McpServer {
  return {
    id: 'srv-1',
    name: 'Hosted Docs',
    transport: 'http',
    command: null,
    args: [],
    envRefs: {},
    url: 'https://mcp.example.com/mcp',
    headerRefs: {},
    enabled: true,
    status: 'unknown',
    toolsCache: null,
    oauth: null,
    ...over,
  };
}

function idToken(payload: Record<string, unknown>): string {
  const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`;
}

function setup() {
  const clock = { t: 1_760_000_000_000 };
  const store = new InMemoryStore();
  const secrets = new FakeSecretStore();
  store.mcpServers.create(makeRow());
  const oauth = new McpOAuthStore(store, secrets, () => clock.t);
  return { clock, store, secrets, oauth };
}

function signInProvider(oauth: McpOAuthStore, onAuthorizationUrl: (url: URL) => void = () => {}): GruntOAuthProvider {
  return new GruntOAuthProvider('srv-1', oauth, { kind: 'sign-in', redirectUri: REDIRECT, state: 'state-1', onAuthorizationUrl });
}

describe('GruntOAuthProvider in sign-in mode', () => {
  it('treats a stored client registered for another redirect address as absent, reuses one for the same address, and prefers a hand-registered client', async () => {
    const { store, oauth } = setup();
    const provider = signInProvider(oauth);

    await oauth.saveRegisteredClient('srv-1', 'http://127.0.0.1:9999/oauth/callback', { client_id: 'old' });
    expect(await provider.clientInformation()).toBeUndefined();

    await oauth.saveRegisteredClient('srv-1', REDIRECT, { client_id: 'dcr-1' });
    expect(await provider.clientInformation()).toMatchObject({ client_id: 'dcr-1' });

    store.mcpServers.update('srv-1', { oauth: { clientId: 'manual-1', clientSecretRef: null, account: null, signedInAt: null } });
    expect(await provider.clientInformation()).toEqual({ client_id: 'manual-1' });
  });

  it('saves a registration with its redirect address, hands the authorization URL over, and keeps the PKCE verifier', async () => {
    const { oauth } = setup();
    const seen: URL[] = [];
    const provider = signInProvider(oauth, (url) => seen.push(url));

    expect(provider.redirectUrl).toBe(REDIRECT);
    expect(provider.clientMetadata).toEqual(clientMetadataFor(REDIRECT));
    expect(await provider.state()).toBe('state-1');
    expect(await provider.tokens()).toBeUndefined();

    await provider.saveClientInformation({ client_id: 'dcr-2' });
    expect(await oauth.registeredClient('srv-1')).toEqual({ redirectUri: REDIRECT, info: { client_id: 'dcr-2' } });

    await provider.saveCodeVerifier('verifier-1');
    expect(await provider.codeVerifier()).toBe('verifier-1');

    await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'));
    expect(seen.map((u) => u.href)).toEqual(['https://auth.example.com/authorize?x=1']);
  });

  it('saves tokens under their secret reference, never in the row, and records the account and time of the sign-in', async () => {
    const { store, secrets, oauth, clock } = setup();
    const provider = signInProvider(oauth);

    await provider.saveTokens({ ...TOKENS, id_token: idToken({ sub: 'u-1', email: 'alice@example.com' }) });

    const stored = JSON.parse((await secrets.get(oauthRefs('srv-1').tokens))!) as { tokens: { access_token: string }; savedAt: number };
    expect(stored.tokens.access_token).toBe('at-1');
    expect(stored.savedAt).toBe(clock.t);
    expect(JSON.stringify(store.mcpServers.get('srv-1'))).not.toContain('at-1');
    expect(store.mcpServers.get('srv-1')!.oauth).toEqual({ clientId: null, clientSecretRef: null, account: 'alice@example.com', signedInAt: clock.t });
  });
});

describe('GruntOAuthProvider in background mode', () => {
  it('has a defined redirect address, so the SDK never takes its client-credentials path', () => {
    const { oauth } = setup();
    expect(new GruntOAuthProvider('srv-1', oauth, { kind: 'background' }).redirectUrl).toBe(BACKGROUND_REDIRECT_URI);
  });

  it('never registers: with no client stored it asks for a sign-in, and refuses to save one', async () => {
    const { oauth } = setup();
    const provider = new GruntOAuthProvider('srv-1', oauth, { kind: 'background' });
    await expect(provider.clientInformation()).rejects.toBeInstanceOf(McpSignInRequiredError);
    await expect(provider.saveClientInformation({ client_id: 'x' })).rejects.toBeInstanceOf(McpSignInRequiredError);
    expect(await oauth.registeredClient('srv-1')).toBeNull();
  });

  it('uses whichever client is stored, whatever redirect address it was made for', async () => {
    const { oauth } = setup();
    await oauth.saveRegisteredClient('srv-1', 'http://127.0.0.1:9999/oauth/callback', { client_id: 'dcr-1' });
    expect(await new GruntOAuthProvider('srv-1', oauth, { kind: 'background' }).clientInformation()).toMatchObject({ client_id: 'dcr-1' });
  });

  it('a refresh keeps the account and sign-in time', async () => {
    const { store, oauth, clock } = setup();
    await signInProvider(oauth).saveTokens({ ...TOKENS, id_token: idToken({ email: 'alice@example.com' }) });
    const signedInAt = clock.t;
    clock.t += 3_600_000;
    await new GruntOAuthProvider('srv-1', oauth, { kind: 'background' }).saveTokens({ access_token: 'at-2', token_type: 'Bearer', refresh_token: 'rt-2' });
    expect(await oauth.tokens('srv-1')).toMatchObject({ access_token: 'at-2' });
    expect(store.mcpServers.get('srv-1')!.oauth).toMatchObject({ account: 'alice@example.com', signedInAt });
  });

  it('redirectToAuthorization with a refresh token held is a transient error and keeps the tokens', async () => {
    const { oauth } = setup();
    await oauth.saveTokens('srv-1', TOKENS, { signIn: true });
    const provider = new GruntOAuthProvider('srv-1', oauth, { kind: 'background' });
    const err = await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(McpSignInRequiredError);
    expect((err as Error).message).toBe("Couldn't refresh the sign-in; will retry.");
    expect(await oauth.tokens('srv-1')).toMatchObject({ access_token: 'at-1' });
  });

  it('redirectToAuthorization without a refresh token forgets the tokens and asks for a sign-in', async () => {
    const { store, oauth } = setup();
    await oauth.saveTokens('srv-1', { access_token: 'at-1', token_type: 'Bearer' }, { signIn: true });
    const provider = new GruntOAuthProvider('srv-1', oauth, { kind: 'background' });
    await expect(provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'))).rejects.toBeInstanceOf(McpSignInRequiredError);
    expect(await oauth.tokens('srv-1')).toBeUndefined();
    expect(store.mcpServers.get('srv-1')!.oauth).toBeNull();
  });

  it("ignores a 'tokens' invalidation within 60 seconds of saving new tokens, and honours one after", async () => {
    const { oauth, clock } = setup();
    const provider = new GruntOAuthProvider('srv-1', oauth, { kind: 'background' });
    await oauth.saveTokens('srv-1', TOKENS, { signIn: false });

    clock.t += 59_000;
    await provider.invalidateCredentials('tokens');
    expect(await oauth.tokens('srv-1')).toMatchObject({ access_token: 'at-1' });

    clock.t += 2_000;
    await provider.invalidateCredentials('tokens');
    expect(await oauth.tokens('srv-1')).toBeUndefined();
  });

  it("'client' forgets only the registered client, 'all' forgets it and the tokens, and a hand-registered client survives both", async () => {
    const { store, oauth } = setup();
    store.mcpServers.update('srv-1', { oauth: { clientId: 'manual-1', clientSecretRef: null, account: null, signedInAt: null } });
    await oauth.saveRegisteredClient('srv-1', REDIRECT, { client_id: 'dcr-1' });
    await oauth.saveTokens('srv-1', TOKENS, { signIn: false });
    const provider = new GruntOAuthProvider('srv-1', oauth, { kind: 'background' });

    await provider.invalidateCredentials('client');
    expect(await oauth.registeredClient('srv-1')).toBeNull();
    expect(await oauth.tokens('srv-1')).toBeDefined();

    await oauth.saveRegisteredClient('srv-1', REDIRECT, { client_id: 'dcr-1' });
    await provider.invalidateCredentials('all');
    expect(await oauth.registeredClient('srv-1')).toBeNull();
    expect(await oauth.tokens('srv-1')).toBeUndefined();
    expect(await oauth.manualClient('srv-1')).toEqual({ client_id: 'manual-1' });
  });

  it('codeVerifier throws: no browser flow ever runs in the background', () => {
    const { oauth } = setup();
    expect(() => new GruntOAuthProvider('srv-1', oauth, { kind: 'background' }).codeVerifier()).toThrow();
  });
});

describe('McpOAuthStore', () => {
  it('forget removes the tokens and registered client, and the hand-registered client unless kept', async () => {
    const { store, secrets, oauth } = setup();
    await secrets.set(oauthRefs('srv-1').clientSecret, 'manual-secret');
    store.mcpServers.update('srv-1', { oauth: { clientId: 'manual-1', clientSecretRef: oauthRefs('srv-1').clientSecret, account: null, signedInAt: null } });
    await oauth.saveRegisteredClient('srv-1', REDIRECT, { client_id: 'dcr-1' });
    await oauth.saveTokens('srv-1', TOKENS, { signIn: true });
    expect(await oauth.manualClient('srv-1')).toEqual({ client_id: 'manual-1', client_secret: 'manual-secret' });

    await oauth.forget('srv-1', { keepManualClient: true });
    expect(await secrets.get(oauthRefs('srv-1').tokens)).toBeNull();
    expect(await secrets.get(oauthRefs('srv-1').client)).toBeNull();
    expect(store.mcpServers.get('srv-1')!.oauth).toEqual({ clientId: 'manual-1', clientSecretRef: oauthRefs('srv-1').clientSecret, account: null, signedInAt: null });

    await oauth.forget('srv-1', { keepManualClient: false });
    expect(await secrets.get(oauthRefs('srv-1').clientSecret)).toBeNull();
    expect(store.mcpServers.get('srv-1')!.oauth).toBeNull();
  });

  it('writes nothing for a server that no longer exists', async () => {
    const { store, secrets, oauth } = setup();
    store.mcpServers.delete('srv-1');
    await oauth.saveTokens('srv-1', TOKENS, { signIn: true });
    await oauth.saveRegisteredClient('srv-1', REDIRECT, { client_id: 'dcr-1' });
    expect(await secrets.get(oauthRefs('srv-1').tokens)).toBeNull();
    expect(await secrets.get(oauthRefs('srv-1').client)).toBeNull();
  });
});

describe('helpers', () => {
  it('accountFromIdToken picks email, then preferred_username, then name, then sub, cut to 200 characters', () => {
    expect(accountFromIdToken(idToken({ sub: 's', name: 'n', preferred_username: 'p', email: 'e@x.com' }))).toBe('e@x.com');
    expect(accountFromIdToken(idToken({ sub: 's', name: 'n', preferred_username: 'p' }))).toBe('p');
    expect(accountFromIdToken(idToken({ sub: 's', name: 'n' }))).toBe('n');
    expect(accountFromIdToken(idToken({ sub: 's' }))).toBe('s');
    expect(accountFromIdToken(idToken({ email: 'a'.repeat(300) }))).toHaveLength(200);
  });

  it('accountFromIdToken returns null for no token or a malformed one', () => {
    expect(accountFromIdToken(undefined)).toBeNull();
    expect(accountFromIdToken('not-a-jwt')).toBeNull();
    expect(accountFromIdToken('a.%%%.c')).toBeNull();
    expect(accountFromIdToken(`x.${Buffer.from('[1,2]').toString('base64url')}.y`)).toBeNull();
  });

  it('hasAuthorizationHeader compares the header name case-insensitively', () => {
    expect(hasAuthorizationHeader({ headerRefs: { authorization: 'ref' } })).toBe(true);
    expect(hasAuthorizationHeader({ headerRefs: { AUTHORIZATION: 'ref' } })).toBe(true);
    expect(hasAuthorizationHeader({ headerRefs: { 'X-Api-Key': 'ref' } })).toBe(false);
  });

  it('isSignInRequired: our error and the SDK UnauthorizedError count; a 401 from the transport circuit breaker and other errors do not', () => {
    expect(isSignInRequired(new McpSignInRequiredError())).toBe(true);
    expect(isSignInRequired(new UnauthorizedError())).toBe(true);
    expect(isSignInRequired(new StreamableHTTPError(401, 'Server returned 401 after successful authentication'))).toBe(false);
    expect(isSignInRequired(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('clientMetadataFor is a public client for exactly one redirect address', () => {
    expect(clientMetadataFor(REDIRECT)).toEqual({
      client_name: 'Grunt',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });
});
