import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedError, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryStore, FakeSecretStore } from '@grunt/core/testing/fakes.js';
import type { McpServer } from '@grunt/core/ports/store.js';
import { McpOAuthStore, oauthRefs } from '../../src/mcp/oauth-store.js';
import {
  BACKGROUND_REDIRECT_URI,
  GruntOAuthProvider,
  McpOAuthMetadataError,
  McpSignInRequiredError,
  accountFromIdToken,
  clientMetadataFor,
  hasAuthorizationHeader,
  isSignInRequired,
  issuerOf,
  type HeldRegistration,
} from '../../src/mcp/oauth-provider.js';

const REDIRECT = 'http://127.0.0.1:4747/oauth/callback';
const TOKENS = { access_token: 'at-1', token_type: 'Bearer', refresh_token: 'rt-1' };
const ISSUER = 'https://auth.example.com';
const OTHER_ISSUER = 'https://evil.example.net';

/** What the SDK's discovery hands the provider before it asks for the client. */
function discovered(provider: GruntOAuthProvider, issuer = ISSUER): GruntOAuthProvider {
  provider.saveDiscoveryState({ authorizationServerUrl: `${issuer}/`, authorizationServerMetadata: { issuer } } as unknown as OAuthDiscoveryState);
  return provider;
}

function registration(clientId: string, over: { redirectUri?: string; issuer?: string } = {}) {
  return { redirectUri: over.redirectUri ?? REDIRECT, issuer: over.issuer ?? ISSUER, info: { client_id: clientId } };
}

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

function signInProvider(oauth: McpOAuthStore, onAuthorizationUrl: (url: URL) => void = () => {}, held?: HeldRegistration): GruntOAuthProvider {
  return discovered(new GruntOAuthProvider('srv-1', oauth, { kind: 'sign-in', redirectUri: REDIRECT, state: 'state-1', onAuthorizationUrl, held }));
}

function backgroundProvider(oauth: McpOAuthStore, resource?: string): GruntOAuthProvider {
  return discovered(new GruntOAuthProvider('srv-1', oauth, { kind: 'background', resource }));
}

describe('GruntOAuthProvider in sign-in mode', () => {
  it('treats a stored client registered for another redirect address or issuer as absent, reuses one for the same pair, and prefers a hand-registered client', async () => {
    const { store, oauth } = setup();

    await oauth.saveRegisteredClient('srv-1', registration('old', { redirectUri: 'http://127.0.0.1:9999/oauth/callback' }));
    expect(await signInProvider(oauth).clientInformation()).toBeUndefined();

    await oauth.saveRegisteredClient('srv-1', registration('elsewhere', { issuer: OTHER_ISSUER }));
    expect(await signInProvider(oauth).clientInformation()).toBeUndefined();

    await oauth.saveRegisteredClient('srv-1', registration('dcr-1'));
    expect(await signInProvider(oauth).clientInformation()).toMatchObject({ client_id: 'dcr-1' });

    store.mcpServers.update('srv-1', { oauth: { clientId: 'manual-1', clientSecretRef: null, account: null, signedInAt: null } });
    expect(await signInProvider(oauth).clientInformation()).toEqual({ client_id: 'manual-1' });
  });

  it('a registration stored without an issuer (an earlier build) counts as absent', async () => {
    const { secrets, oauth } = setup();
    await secrets.set(oauthRefs('srv-1').client, JSON.stringify({ redirectUri: REDIRECT, info: { client_id: 'no-issuer' } }));
    expect(await oauth.registeredClient('srv-1')).toBeNull();
    expect(await signInProvider(oauth).clientInformation()).toBeUndefined();
  });

  it('holds a new registration on the flow and saves it, with its issuer, only with the sign-in tokens', async () => {
    const { oauth } = setup();
    const held: HeldRegistration = { current: null };
    const provider = signInProvider(oauth, () => {}, held);

    await provider.saveClientInformation({ client_id: 'dcr-2' });
    expect(await oauth.registeredClient('srv-1')).toBeNull();
    expect(held.current).toEqual(registration('dcr-2'));
    expect(await provider.clientInformation()).toEqual({ client_id: 'dcr-2' }); // the code exchange uses it

    // The next start (this one was replaced or cancelled) reuses the held one rather than registering again.
    expect(await signInProvider(oauth, () => {}, held).clientInformation()).toEqual({ client_id: 'dcr-2' });

    await provider.saveTokens(TOKENS);
    expect(await oauth.registeredClient('srv-1')).toEqual(registration('dcr-2'));
    expect(held.current).toBeNull();
  });

  it('hands the authorization URL over and keeps the PKCE verifier', async () => {
    const { oauth } = setup();
    const seen: URL[] = [];
    const provider = signInProvider(oauth, (url) => seen.push(url));

    expect(provider.redirectUrl).toBe(REDIRECT);
    expect(provider.clientMetadata).toEqual(clientMetadataFor(REDIRECT));
    expect(await provider.state()).toBe('state-1');
    expect(await provider.tokens()).toBeUndefined();

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

  it('uses the stored client whatever redirect address it was made for, but never with another authorization server', async () => {
    const { oauth } = setup();
    await oauth.saveRegisteredClient('srv-1', registration('dcr-1', { redirectUri: 'http://127.0.0.1:9999/oauth/callback' }));
    expect(await backgroundProvider(oauth).clientInformation()).toMatchObject({ client_id: 'dcr-1' });
    await expect(discovered(new GruntOAuthProvider('srv-1', oauth, { kind: 'background' }), OTHER_ISSUER).clientInformation()).rejects.toBeInstanceOf(McpSignInRequiredError);
  });

  it('a provider built before a sign-out or a new sign-in can no longer save, forget or invalidate', async () => {
    const { oauth } = setup();
    await oauth.saveTokens('srv-1', TOKENS, { signIn: true });
    await oauth.saveRegisteredClient('srv-1', registration('dcr-1'));
    const stale = backgroundProvider(oauth);

    await oauth.forget('srv-1', { keepManualClient: true }); // sign-out
    await stale.saveTokens({ access_token: 'at-late', token_type: 'Bearer', refresh_token: 'rt-late' });
    expect(await oauth.tokens('srv-1')).toBeUndefined();

    await oauth.saveRegisteredClient('srv-1', registration('dcr-2'));
    await signInProvider(oauth).saveTokens({ access_token: 'at-new', token_type: 'Bearer', refresh_token: 'rt-new' }); // a new sign-in
    await stale.saveTokens({ access_token: 'at-late', token_type: 'Bearer' });
    await stale.invalidateCredentials('all');
    await expect(stale.redirectToAuthorization(new URL('https://auth.example.com/authorize'))).rejects.toThrow();
    expect(await oauth.tokens('srv-1')).toMatchObject({ access_token: 'at-new' });
    expect(await oauth.registeredClient('srv-1')).toMatchObject({ info: { client_id: 'dcr-2' } });

    // One built now refreshes as usual, and a refresh starts no new generation.
    const current = backgroundProvider(oauth);
    const generation = oauth.generation('srv-1');
    await current.saveTokens({ access_token: 'at-refreshed', token_type: 'Bearer', refresh_token: 'rt-refreshed' });
    expect(oauth.generation('srv-1')).toBe(generation);
    expect(await oauth.tokens('srv-1')).toMatchObject({ access_token: 'at-refreshed' });
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
    await oauth.saveRegisteredClient('srv-1', registration('dcr-1'));
    await oauth.saveTokens('srv-1', TOKENS, { signIn: false });
    const provider = new GruntOAuthProvider('srv-1', oauth, { kind: 'background' });

    await provider.invalidateCredentials('client');
    expect(await oauth.registeredClient('srv-1')).toBeNull();
    expect(await oauth.tokens('srv-1')).toBeDefined();

    await oauth.saveRegisteredClient('srv-1', registration('dcr-1'));
    await provider.invalidateCredentials('all');
    expect(await oauth.registeredClient('srv-1')).toBeNull();
    expect(await oauth.tokens('srv-1')).toBeUndefined();
    expect(await oauth.manualClient('srv-1')).toEqual({ client_id: 'manual-1' });
  });

  it('refuses discovery whose issuer is not the address it was found at, or whose address has userinfo', () => {
    const { oauth } = setup();
    const provider = new GruntOAuthProvider('srv-1', oauth, { kind: 'background' });
    const state = (authorizationServerUrl: string, issuer?: string) =>
      ({ authorizationServerUrl, ...(issuer !== undefined ? { authorizationServerMetadata: { issuer } } : {}) }) as unknown as OAuthDiscoveryState;

    expect(() => provider.saveDiscoveryState(state('https://auth.example.com/', 'https://evil.example'))).toThrow(McpOAuthMetadataError);
    expect(() => provider.saveDiscoveryState(state('https://auth.example.com/tenant', 'https://auth.example.com/other'))).toThrow(McpOAuthMetadataError);
    expect(() => provider.saveDiscoveryState(state('https://good@auth.example.com/'))).toThrow(McpOAuthMetadataError);
    expect(provider.discoveryState()).toBeUndefined();

    provider.saveDiscoveryState(state('https://auth.example.com/', 'https://Auth.Example.com'));
    expect(issuerOf(provider.discoveryState())).toBe('https://Auth.Example.com');
    provider.saveDiscoveryState(state('https://auth.example.com/')); // no metadata found: nothing to compare
  });

  it('validateResourceURL accepts metadata for this server or its root, and refuses a sibling path or another origin', async () => {
    const { oauth } = setup();
    const provider = new GruntOAuthProvider('srv-1', oauth, { kind: 'background' });
    const server = new URL('https://mcp.example.com/mcp');
    expect(await provider.validateResourceURL(server, undefined)).toBeUndefined();
    expect((await provider.validateResourceURL(server, 'https://mcp.example.com/mcp'))?.href).toBe('https://mcp.example.com/mcp');
    expect((await provider.validateResourceURL(server, 'https://mcp.example.com/'))?.href).toBe('https://mcp.example.com/');
    await expect(provider.validateResourceURL(server, 'https://mcp.example.com/mcp-evil')).rejects.toBeInstanceOf(McpOAuthMetadataError);
    await expect(provider.validateResourceURL(server, 'https://evil.example/mcp')).rejects.toBeInstanceOf(McpOAuthMetadataError);
    await expect(provider.validateResourceURL(server, 'https://mcp.example.com@evil.example/mcp')).rejects.toBeInstanceOf(McpOAuthMetadataError);
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
    await oauth.saveRegisteredClient('srv-1', registration('dcr-1'));
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

  describe('tokens are bound to the URL they were issued for', () => {
    const OLD_URL = 'https://mcp.example.com/mcp';
    const NEW_URL = 'https://other.example.com/mcp';

    it('stores the resource with the tokens, and returns them only while the row still has that URL', async () => {
      const { store, secrets, oauth } = setup();
      await signInProvider(oauth).saveTokens(TOKENS);
      expect(JSON.parse((await secrets.get(oauthRefs('srv-1').tokens))!)).toMatchObject({ resource: OLD_URL });
      expect(await oauth.tokens('srv-1')).toMatchObject({ access_token: 'at-1' });

      store.mcpServers.update('srv-1', { url: NEW_URL });
      expect(await oauth.tokens('srv-1')).toBeUndefined();
      expect(await oauth.lastSavedAt('srv-1')).toBeNull();

      // A cold cache (a restart) reads the same stored entry and reaches the same answer.
      const cold = new McpOAuthStore(store, secrets);
      expect(await cold.tokens('srv-1')).toBeUndefined();
      store.mcpServers.update('srv-1', { url: OLD_URL });
      expect(await cold.tokens('srv-1')).toMatchObject({ access_token: 'at-1' });
    });

    it('compares the resource by its parsed, normalised parts, and an older raw entry still matches', async () => {
      const { store, secrets, oauth } = setup();
      await signInProvider(oauth).saveTokens(TOKENS);

      store.mcpServers.update('srv-1', { url: 'https://MCP.Example.com.:443/m%63p' });
      expect(await oauth.tokens('srv-1')).toMatchObject({ access_token: 'at-1' });

      // An entry written before resources were normalised, in another spelling of the same address.
      await secrets.set(oauthRefs('srv-1').tokens, JSON.stringify({ tokens: TOKENS, savedAt: 1, resource: 'https://mcp.example.com:443/mcp' }));
      store.mcpServers.update('srv-1', { url: OLD_URL });
      expect(await new McpOAuthStore(store, secrets).tokens('srv-1')).toMatchObject({ access_token: 'at-1' });
    });

    it('tokens bound to /mcp are never used for /mcp-evil, or for the same address with userinfo', async () => {
      const { store, oauth } = setup();
      await signInProvider(oauth).saveTokens(TOKENS);

      store.mcpServers.update('srv-1', { url: 'https://mcp.example.com/mcp-evil' });
      expect(await oauth.tokens('srv-1')).toBeUndefined();
      store.mcpServers.update('srv-1', { url: 'https://user@mcp.example.com/mcp' });
      expect(await oauth.tokens('srv-1')).toBeUndefined();
      store.mcpServers.update('srv-1', { url: OLD_URL });
      // A connection built for /mcp-evil gets nothing even while the row says /mcp, and can't save for it.
      const sibling = new GruntOAuthProvider('srv-1', oauth, { kind: 'background', resource: 'https://mcp.example.com/mcp-evil' });
      expect(await sibling.tokens()).toBeUndefined();
      await sibling.saveTokens({ access_token: 'at-evil', token_type: 'Bearer' });
      expect(await oauth.tokens('srv-1')).toMatchObject({ access_token: 'at-1' });
    });

    it('stores the resource normalised, and saves nothing for an address with userinfo', async () => {
      const { store, secrets, oauth } = setup();
      store.mcpServers.update('srv-1', { url: 'https://MCP.example.com:443/mcp' });
      await signInProvider(oauth).saveTokens(TOKENS);
      expect(JSON.parse((await secrets.get(oauthRefs('srv-1').tokens))!)).toMatchObject({ resource: 'https://mcp.example.com/mcp' });

      await oauth.forgetTokens('srv-1');
      store.mcpServers.update('srv-1', { url: 'https://good@mcp.example.com/mcp' });
      await signInProvider(oauth).saveTokens(TOKENS);
      expect(await secrets.get(oauthRefs('srv-1').tokens)).toBeNull();
    });

    it('treats an entry with no resource as a mismatch', async () => {
      const { secrets, store, oauth } = setup();
      await secrets.set(oauthRefs('srv-1').tokens, JSON.stringify({ tokens: TOKENS, savedAt: 1 }));
      expect(await new McpOAuthStore(store, secrets).tokens('srv-1')).toBeUndefined();
      expect(await oauth.tokens('srv-1')).toBeUndefined();
    });

    it('a background provider built for the old URL gets no tokens once the row has moved, and its late save is dropped', async () => {
      const { store, secrets, oauth } = setup();
      const stale = new GruntOAuthProvider('srv-1', oauth, { kind: 'background', resource: OLD_URL });
      await stale.saveTokens(TOKENS);
      store.mcpServers.update('srv-1', { url: NEW_URL });
      await oauth.forget('srv-1', { keepManualClient: true });

      // The refresh that was in flight finishes after the edit.
      await stale.saveTokens({ access_token: 'at-late', token_type: 'Bearer', refresh_token: 'rt-late' });
      expect(await secrets.get(oauthRefs('srv-1').tokens)).toBeNull();
      expect(await oauth.tokens('srv-1')).toBeUndefined();

      // Tokens for the new URL are never offered to a provider built for the old one.
      await new GruntOAuthProvider('srv-1', oauth, { kind: 'background', resource: NEW_URL }).saveTokens({ access_token: 'at-new', token_type: 'Bearer' });
      expect(await stale.tokens()).toBeUndefined();
      expect(await new GruntOAuthProvider('srv-1', oauth, { kind: 'background', resource: NEW_URL }).tokens()).toMatchObject({ access_token: 'at-new' });
    });

    it('a sign-in binds its tokens to the URL it started against, not the row at completion', async () => {
      const { store, secrets, oauth } = setup();
      const provider = new GruntOAuthProvider('srv-1', oauth, { kind: 'sign-in', redirectUri: REDIRECT, state: 's', onAuthorizationUrl: () => {}, resource: OLD_URL });
      store.mcpServers.update('srv-1', { url: NEW_URL });
      await provider.saveTokens(TOKENS);
      expect(await secrets.get(oauthRefs('srv-1').tokens)).toBeNull();
      expect(await oauth.tokens('srv-1')).toBeUndefined();
      expect(store.mcpServers.get('srv-1')!.oauth).toBeNull();
    });

    it('a save whose write lands after the row was deleted leaves nothing behind', async () => {
      const { store, secrets, oauth } = setup();
      const realSet = secrets.set.bind(secrets);
      vi.spyOn(secrets, 'set').mockImplementation(async (ref, value) => {
        store.mcpServers.delete('srv-1'); // the delete lands while the write is in flight
        await realSet(ref, value);
      });
      await oauth.saveTokens('srv-1', TOKENS, { signIn: true });
      expect(await secrets.get(oauthRefs('srv-1').tokens)).toBeNull();
      vi.restoreAllMocks();
    });
  });

  it('writes nothing for a server that no longer exists', async () => {
    const { store, secrets, oauth } = setup();
    store.mcpServers.delete('srv-1');
    await oauth.saveTokens('srv-1', TOKENS, { signIn: true });
    await oauth.saveRegisteredClient('srv-1', registration('dcr-1'));
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

  it('issuerOf prefers the metadata issuer, else the authorization server URL', () => {
    expect(issuerOf({ authorizationServerUrl: 'https://a.example/', authorizationServerMetadata: { issuer: 'https://a.example' } } as unknown as OAuthDiscoveryState)).toBe('https://a.example');
    expect(issuerOf({ authorizationServerUrl: 'https://a.example/' } as OAuthDiscoveryState)).toBe('https://a.example/');
    expect(issuerOf(undefined)).toBeUndefined();
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
