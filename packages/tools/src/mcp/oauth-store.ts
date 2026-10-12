import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SecretStore } from '@grunt/core/ports/secret-store.js';
import type { McpServerOAuth, Store } from '@grunt/core/ports/store.js';
import { accountFromIdToken } from './oauth-provider.js';

/** The SecretStore references one server's sign-in lives under. */
export function oauthRefs(serverId: string): { tokens: string; client: string; clientSecret: string } {
  return {
    tokens: `mcp:${serverId}:oauth:tokens`,
    client: `mcp:${serverId}:oauth:client`,
    clientSecret: `mcp:${serverId}:oauth:client-secret`,
  };
}

export interface StoredTokens {
  tokens: OAuthTokens;
  savedAt: number;
}

/** A dynamic registration, kept with the redirect address it was made for. May hold a client secret, hence SecretStore. */
export interface RegisteredClient {
  redirectUri: string;
  info: OAuthClientInformationMixed;
}

export interface ManualClient {
  client_id: string;
  client_secret?: string;
}

const NO_OAUTH: McpServerOAuth = { clientId: null, clientSecretRef: null, account: null, signedInAt: null };

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * The one place OAuth state is read and written (spec 2026-10-12-mcp-oauth-design §3),
 * owned by `McpServerManager`. Tokens, registrations and a hand-registered
 * secret go to SecretStore; the row's `oauth` column only ever holds the
 * non-secret summary. Tokens are cached per server because `tokens()` runs
 * on every MCP request; every write goes through here, so the cache can't go stale.
 */
export class McpOAuthStore {
  private readonly tokenCache = new Map<string, StoredTokens | null>();

  constructor(
    private readonly store: Store,
    private readonly secrets: SecretStore,
    readonly now: () => number = Date.now
  ) {}

  async tokens(serverId: string): Promise<OAuthTokens | undefined> {
    return (await this.loadTokens(serverId))?.tokens;
  }

  /** The token strings held in memory right now, for redacting error text without reading the SecretStore. */
  cachedSecrets(serverId: string): string[] {
    const tokens = this.tokenCache.get(serverId)?.tokens;
    return [tokens?.access_token, tokens?.refresh_token, tokens?.id_token].filter((v): v is string => typeof v === 'string' && v.length > 0);
  }

  async lastSavedAt(serverId: string): Promise<number | null> {
    return (await this.loadTokens(serverId))?.savedAt ?? null;
  }

  async saveTokens(serverId: string, tokens: OAuthTokens, opts: { signIn: boolean }): Promise<void> {
    if (!this.store.mcpServers.get(serverId)) return; // deleted while a sign-in or refresh was in flight
    const entry: StoredTokens = { tokens, savedAt: this.now() };
    // Cached before the write, so a request racing this one already sends the new token.
    this.tokenCache.set(serverId, entry);
    await this.secrets.set(oauthRefs(serverId).tokens, JSON.stringify(entry));
    if (opts.signIn) this.patchSummary(serverId, { account: accountFromIdToken(tokens.id_token), signedInAt: entry.savedAt });
  }

  async forgetTokens(serverId: string): Promise<void> {
    this.tokenCache.set(serverId, null);
    await this.secrets.delete(oauthRefs(serverId).tokens);
    this.patchSummary(serverId, { account: null, signedInAt: null });
  }

  async registeredClient(serverId: string): Promise<RegisteredClient | null> {
    return parseJson<RegisteredClient>(await this.secrets.get(oauthRefs(serverId).client));
  }

  async saveRegisteredClient(serverId: string, redirectUri: string, info: OAuthClientInformationMixed): Promise<void> {
    if (!this.store.mcpServers.get(serverId)) return;
    const entry: RegisteredClient = { redirectUri, info };
    await this.secrets.set(oauthRefs(serverId).client, JSON.stringify(entry));
  }

  async forgetRegisteredClient(serverId: string): Promise<void> {
    await this.secrets.delete(oauthRefs(serverId).client);
  }

  /** The hand-registered client ("Sign-in app"), or null when Grunt registers itself. */
  async manualClient(serverId: string): Promise<ManualClient | null> {
    const oauth = this.store.mcpServers.get(serverId)?.oauth;
    if (!oauth?.clientId) return null;
    const secret = oauth.clientSecretRef ? await this.secrets.get(oauth.clientSecretRef) : null;
    return secret ? { client_id: oauth.clientId, client_secret: secret } : { client_id: oauth.clientId };
  }

  /** Tokens and registered client, and the hand-registered client too unless kept. */
  async forget(serverId: string, opts: { keepManualClient: boolean }): Promise<void> {
    await this.forgetTokens(serverId);
    await this.forgetRegisteredClient(serverId);
    if (!opts.keepManualClient) {
      await this.secrets.delete(oauthRefs(serverId).clientSecret);
      this.patchSummary(serverId, { clientId: null, clientSecretRef: null });
    }
  }

  private async loadTokens(serverId: string): Promise<StoredTokens | null> {
    const cached = this.tokenCache.get(serverId);
    if (cached !== undefined) return cached;
    const parsed = parseJson<StoredTokens>(await this.secrets.get(oauthRefs(serverId).tokens));
    // A save or forget may have landed while we were reading; it wins.
    if (!this.tokenCache.has(serverId)) this.tokenCache.set(serverId, parsed);
    return this.tokenCache.get(serverId) ?? null;
  }

  /** Merges into the row's summary; an all-empty summary is stored as null. A deleted row is left alone. */
  private patchSummary(serverId: string, patch: Partial<McpServerOAuth>): void {
    const row = this.store.mcpServers.get(serverId);
    if (!row) return;
    const next: McpServerOAuth = { ...(row.oauth ?? NO_OAUTH), ...patch };
    const empty = next.clientId === null && next.clientSecretRef === null && next.account === null && next.signedInAt === null;
    this.store.mcpServers.update(serverId, { oauth: empty ? null : next });
  }
}
