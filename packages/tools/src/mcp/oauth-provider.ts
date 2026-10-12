import { randomBytes } from 'node:crypto';
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpServer } from '@grunt/core/ports/store.js';
import type { McpOAuthStore } from './oauth-store.js';

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

export type GruntOAuthMode =
  | { kind: 'background' }
  | { kind: 'sign-in'; redirectUri: string; state: string; onAuthorizationUrl: (url: URL) => void };

/**
 * The MCP SDK's `OAuthClientProvider` for one server (spec
 * 2026-10-12-mcp-oauth-design §3). `background`: one per connection, uses
 * stored tokens and refreshes them, never registers and never starts a
 * browser flow. `sign-in`: one per pending browser flow, starts fresh.
 *
 * Relies on the order inside SDK 1.30.0's `auth()`: `clientInformation()`
 * before `tokens()`, then a refresh, then `redirectToAuthorization`; and on
 * `InvalidGrantError` it calls `invalidateCredentials('tokens')` and retries
 * once. That is why `packages/tools` pins the SDK exactly.
 */
export class GruntOAuthProvider implements OAuthClientProvider {
  private verifier: string | null = null;
  private discovery: OAuthDiscoveryState | undefined;

  constructor(
    private readonly serverId: string,
    private readonly oauth: McpOAuthStore,
    private readonly mode: GruntOAuthMode
  ) {}

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
    const registered = await this.oauth.registeredClient(this.serverId);
    if (this.mode.kind === 'sign-in') {
      // A registration made for another redirect address (the desktop app's port changes every launch) can't be used: register again.
      return registered && registered.redirectUri === this.mode.redirectUri ? registered.info : undefined;
    }
    if (registered) return registered.info;
    throw new McpSignInRequiredError();
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    if (this.mode.kind !== 'sign-in') throw new McpSignInRequiredError();
    await this.oauth.saveRegisteredClient(this.serverId, this.mode.redirectUri, info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // A sign-in starts fresh: the first request goes without a token, gets the 401 and starts the flow.
    return this.mode.kind === 'sign-in' ? undefined : this.oauth.tokens(this.serverId);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.oauth.saveTokens(this.serverId, tokens, { signIn: this.mode.kind === 'sign-in' });
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
    await this.oauth.forgetTokens(this.serverId);
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
    if (scope === 'all' || scope === 'client') await this.oauth.forgetRegisteredClient(this.serverId); // never the hand-registered one
    if (this.mode.kind === 'sign-in') return; // a sign-in holds no tokens to forget
    if (scope === 'all') {
      await this.oauth.forgetTokens(this.serverId);
      return;
    }
    if (scope === 'tokens') {
      // Two requests refreshing at once with a rotating refresh token: the loser gets invalid_grant. Ignore it if we just saved new tokens; the SDK retries with them.
      const savedAt = await this.oauth.lastSavedAt(this.serverId);
      if (savedAt !== null && this.oauth.now() - savedAt < REFRESH_GRACE_MS) return;
      await this.oauth.forgetTokens(this.serverId);
    }
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }
}
