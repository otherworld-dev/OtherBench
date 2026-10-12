import { randomBytes } from 'node:crypto';
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpServer } from '@grunt/core/ports/store.js';
import type { McpOAuthStore, RegisteredClient } from './oauth-store.js';

/**
 * Background mode's redirect address. Never sent anywhere: refresh doesn't
 * use one, and the authorization URL the SDK builds with it is discarded by
 * `redirectToAuthorization`, which always throws in the background. It only
 * has to be defined -- `auth()` treats an undefined `redirectUrl` as a
 * non-interactive (client-credentials) flow.
 */
export const BACKGROUND_REDIRECT_URI = 'http://127.0.0.1/oauth/callback';

/** A background request to forget tokens this soon after saving new ones is a refresh race, not a revoked sign-in. */
export const REFRESH_GRACE_MS = 60_000;

export const SIGN_IN_REQUIRED_MESSAGE = 'This server needs you to sign in.';

/** Thrown by the background provider when only a browser sign-in can help. `McpClient` turns it into `needs_auth`. */
export class McpSignInRequiredError extends Error {
  constructor(message = SIGN_IN_REQUIRED_MESSAGE) {
    super(message);
    this.name = 'McpSignInRequiredError';
  }
}

/**
 * True when the error means "only a sign-in can fix this". Deliberately not
 * the SDK's `StreamableHTTPError` 401: in SDK 1.30.0 that is only raised by
 * the transport's `_hasCompletedAuthFlow` circuit breaker, a flag shared by
 * every request on the transport, so two requests racing a refresh can trip
 * it with good tokens. It stays an ordinary error and is retried.
 */
export function isSignInRequired(err: unknown): boolean {
  return err instanceof McpSignInRequiredError || err instanceof UnauthorizedError;
}

/** A configured `Authorization` header (any case) means a fixed credential: no OAuth for that server. */
export function hasAuthorizationHeader(row: Pick<McpServer, 'headerRefs'>): boolean {
  return Object.keys(row.headerRefs).some((name) => name.toLowerCase() === 'authorization');
}

/**
 * "Signed in as …" from an id_token: its payload's email, else
 * preferred_username, else name, else sub, cut to 200 characters. Decoded
 * only, never verified: it is a label, never used for a decision.
 */
export function accountFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payloadPart = idToken.split('.')[1];
  if (!payloadPart) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    for (const key of ['email', 'preferred_username', 'name', 'sub']) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim().length > 0) return value.slice(0, 200);
    }
    return null;
  } catch {
    return null;
  }
}

/** Grunt's dynamic-registration metadata: a public client (PKCE, no secret) for one redirect address. */
export function clientMetadataFor(redirectUri: string): OAuthClientMetadata {
  return {
    client_name: 'Grunt',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/** The authorization server a discovery found: its metadata's issuer, else the URL the SDK settled on. */
export function issuerOf(state: OAuthDiscoveryState | undefined): string | undefined {
  return state?.authorizationServerMetadata?.issuer ?? state?.authorizationServerUrl;
}

/**
 * A registration made by a sign-in that hasn't completed, held in memory
 * per server (by `McpSignIns`) so the next start can reuse it rather than
 * register again. It replaces the stored registration only when a sign-in
 * that used it completes: until then the stored one is what the live tokens
 * were issued to, and a refresh needs it.
 */
export interface HeldRegistration {
  current: RegisteredClient | null;
}

/**
 * `resource` is the server URL the connection (or the sign-in flow, from the
 * moment it started) was made against: tokens it saves are bound to that URL,
 * not to whatever the row says by the time the request finishes. Defaults to
 * the row's current URL.
 */
export type GruntOAuthMode =
  | { kind: 'background'; resource?: string }
  | { kind: 'sign-in'; redirectUri: string; state: string; onAuthorizationUrl: (url: URL) => void; resource?: string; held?: HeldRegistration };

/**
 * The MCP SDK's `OAuthClientProvider` for one server (spec
 * 2026-10-12-mcp-oauth-design §3). `background`: one per connection, uses
 * stored tokens and refreshes them, never registers and never starts a
 * browser flow. `sign-in`: one per pending browser flow, starts fresh.
 *
 * Relies on the order inside SDK 1.30.0's `auth()`: discovery, then
 * `clientInformation()`, then `tokens()`, then a refresh, then
 * `redirectToAuthorization`; and on `InvalidGrantError` it calls
 * `invalidateCredentials('tokens')` and retries once. That is why
 * `packages/tools` pins the SDK exactly.
 *
 * A background provider captures its server's token generation when it is
 * built (`McpOAuthStore`): its saves and forgets carry it, so once the server
 * is signed out or signed in again they are dropped. The manager builds a new
 * connection (and provider) after each of those.
 */
export class GruntOAuthProvider implements OAuthClientProvider {
  private verifier: string | null = null;
  private discovery: OAuthDiscoveryState | undefined;
  private readonly generation: number;
  /** Sign-in: the registration this flow uses, and whether it is the stored one. */
  private flowClient: { entry: RegisteredClient; stored: boolean } | null = null;
  /** Sign-in: the provider refused the stored registration; register again. */
  private skipStored = false;

  constructor(
    private readonly serverId: string,
    private readonly oauth: McpOAuthStore,
    private readonly mode: GruntOAuthMode
  ) {
    this.generation = oauth.generation(serverId);
  }

  get redirectUrl(): string {
    return this.mode.kind === 'sign-in' ? this.mode.redirectUri : BACKGROUND_REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return clientMetadataFor(this.redirectUrl);
  }

  state(): string {
    return this.mode.kind === 'sign-in' ? this.mode.state : randomBytes(16).toString('base64url');
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const manual = await this.oauth.manualClient(this.serverId);
    if (manual) return manual;
    // The SDK runs discovery first, so the authorization server is known here. A registration made with another one is never sent to this one.
    const issuer = issuerOf(this.discovery);
    const mode = this.mode;
    if (mode.kind === 'sign-in') {
      if (this.flowClient) return this.flowClient.entry.info;
      // A registration made for another redirect address (the desktop app's port changes every launch) can't be used: register again.
      const usable = (entry: RegisteredClient | null | undefined): entry is RegisteredClient =>
        !!entry && issuer !== undefined && entry.issuer === issuer && entry.redirectUri === mode.redirectUri;
      const stored = this.skipStored ? null : await this.oauth.registeredClient(this.serverId);
      if (usable(stored)) {
        this.flowClient = { entry: stored, stored: true };
        return stored.info;
      }
      const held = mode.held?.current;
      if (usable(held)) {
        this.flowClient = { entry: held, stored: false };
        return held.info;
      }
      return undefined;
    }
    const registered = await this.oauth.registeredClient(this.serverId);
    if (registered && issuer !== undefined && registered.issuer === issuer) return registered.info;
    throw new McpSignInRequiredError();
  }

  /** Sign-in: holds the new registration on the flow (and for the next start). It is saved only when this sign-in completes. */
  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    if (this.mode.kind !== 'sign-in') throw new McpSignInRequiredError();
    const entry: RegisteredClient = { redirectUri: this.mode.redirectUri, issuer: issuerOf(this.discovery) ?? '', info };
    this.flowClient = { entry, stored: false };
    if (this.mode.held) this.mode.held.current = entry;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // A sign-in starts fresh: the first request goes without a token, gets the 401 and starts the flow.
    return this.mode.kind === 'sign-in' ? undefined : this.oauth.tokens(this.serverId, this.mode.resource);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    if (this.mode.kind === 'background') {
      // A refresh: dropped if the server was signed out or signed in again since this provider was built.
      await this.oauth.saveTokens(this.serverId, tokens, { signIn: false, resource: this.mode.resource, generation: this.generation });
      return;
    }
    const saved = await this.oauth.saveTokens(this.serverId, tokens, { signIn: true, resource: this.mode.resource });
    // The tokens were issued to this flow's client: a new registration becomes the stored one now, not before.
    const client = this.flowClient;
    if (saved && client && !client.stored) {
      await this.oauth.saveRegisteredClient(this.serverId, client.entry);
      if (this.mode.held?.current === client.entry) this.mode.held.current = null;
      this.flowClient = { entry: client.entry, stored: true };
    }
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (this.mode.kind === 'sign-in') {
      this.mode.onAuthorizationUrl(url);
      return;
    }
    // Background: the SDK only gets here when a refresh didn't happen or didn't work.
    const held = await this.oauth.tokens(this.serverId);
    // Still holding a refresh token means the refresh failed for a reason other than invalid_grant (provider down): transient.
    if (held?.refresh_token) throw new Error("Couldn't refresh the sign-in; will retry.");
    await this.oauth.forgetTokens(this.serverId, { generation: this.generation });
    throw new McpSignInRequiredError();
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (this.mode.kind === 'sign-in') this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.mode.kind !== 'sign-in' || this.verifier === null) throw new Error('No sign-in is in progress for this server.');
    return this.verifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'discovery') {
      this.discovery = undefined;
      return;
    }
    if (scope === 'verifier') return;
    if (this.mode.kind === 'sign-in') {
      // The provider refused this flow's client: drop it and register again. The stored registration stays, since live tokens may use it; a sign-in holds no tokens to forget.
      if (scope === 'all' || scope === 'client') {
        if (this.mode.held && this.mode.held.current === this.flowClient?.entry) this.mode.held.current = null;
        this.flowClient = null;
        this.skipStored = true;
      }
      return;
    }
    // Background: every forget carries this provider's generation, so a stale connection's invalidation can't wipe a newer sign-in.
    const generation = this.generation;
    if (scope === 'all' || scope === 'client') await this.oauth.forgetRegisteredClient(this.serverId, { generation }); // never the hand-registered one
    if (scope === 'all') {
      await this.oauth.forgetTokens(this.serverId, { generation });
      return;
    }
    if (scope === 'tokens') {
      // Two requests refreshing at once with a rotating refresh token: the loser gets invalid_grant. Ignore it if we just saved new tokens; the SDK retries with them.
      const savedAt = await this.oauth.lastSavedAt(this.serverId);
      if (savedAt !== null && this.oauth.now() - savedAt < REFRESH_GRACE_MS) return;
      await this.oauth.forgetTokens(this.serverId, { generation });
    }
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }
}
