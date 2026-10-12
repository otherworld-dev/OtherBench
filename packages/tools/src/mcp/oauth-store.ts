import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SecretStore } from '@grunt/core/ports/secret-store.js';
import type { McpServerOAuth, Store } from '@grunt/core/ports/store.js';
import { accountFromIdToken } from './oauth-provider.js';
import { normaliseResource, sameResource } from './url.js';

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
  /** The server URL these tokens were issued for, normalised (`url.ts`). They are only ever used while the row's URL names the same resource (both sides normalised when compared, so older raw entries still match); an entry without one is never used. */
  resource: string;
}

/**
 * A dynamic registration, kept with the redirect address it was made for and
 * the authorization server (its issuer) it was made with: one made with
 * another issuer is never sent anywhere. May hold a client secret, hence SecretStore.
 */
export interface RegisteredClient {
  redirectUri: string;
  issuer: string;
  info: OAuthClientInformationMixed;
}

function isRegisteredClient(value: unknown): value is RegisteredClient {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const info = v['info'] as Record<string, unknown> | null | undefined;
  return typeof v['redirectUri'] === 'string' && typeof v['issuer'] === 'string' && typeof info === 'object' && info !== null && typeof info['client_id'] === 'string';
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
 *
 * Each server has a token generation, bumped by every forget and every
 * sign-in save. A background provider captures it when it is built and
 * passes it with its writes; a write from an older generation is dropped.
 * That is what stops a refresh still in flight from bringing tokens back
 * after a sign-out (the SDK's `transport.close()` doesn't abort a request
 * inside `auth()`), from overwriting a newer sign-in's tokens, or from
 * forgetting them. A refresh's own save advances nothing. Token and
 * registration writes for one server run one at a time, so a check and the
 * write it guards can't interleave with another write.
 */
export class McpOAuthStore {
  private readonly tokenCache = new Map<string, StoredTokens | null>();
  private readonly generations = new Map<string, number>();
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly secrets: SecretStore,
    readonly now: () => number = Date.now
  ) {}

  /** The tokens, only while they are bound to the row's current URL (read synchronously, after the load). */
  async tokens(serverId: string, resource?: string): Promise<OAuthTokens | undefined> {
    const entry = this.boundTo(serverId, await this.loadTokens(serverId));
    // A connection built for another URL than the row's current one (replaced mid-request) gets nothing either.
    if (entry && resource !== undefined && !sameResource(resource, entry.resource)) return undefined;
    return entry?.tokens;
  }

  /** The token strings held in memory right now, for redacting error text without reading the SecretStore. */
  cachedSecrets(serverId: string): string[] {
    const tokens = this.tokenCache.get(serverId)?.tokens;
    return [tokens?.access_token, tokens?.refresh_token, tokens?.id_token].filter((v): v is string => typeof v === 'string' && v.length > 0);
  }

  async lastSavedAt(serverId: string): Promise<number | null> {
    return this.boundTo(serverId, await this.loadTokens(serverId))?.savedAt ?? null;
  }

  /** This server's token generation (see the class comment). */
  generation(serverId: string): number {
    return this.generations.get(serverId) ?? 0;
  }

  /**
   * `resource` is the URL the caller's connection or sign-in was made against
   * (defaults to the row's current URL). A save for a URL the row no longer
   * has is dropped: that connection was replaced while its request was in flight.
   * `generation` (background providers): a save from an older generation is
   * dropped too. A sign-in save starts a new generation. True when saved.
   */
  saveTokens(serverId: string, tokens: OAuthTokens, opts: { signIn: boolean; resource?: string; generation?: number }): Promise<boolean> {
    return this.serial(serverId, async () => {
      const row = this.store.mcpServers.get(serverId);
      if (!row) return false; // deleted while a sign-in or refresh was in flight
      if (opts.generation !== undefined && opts.generation !== this.generation(serverId)) return false; // signed out, or signed in again, since
      const resource = normaliseResource(opts.resource ?? row.url ?? '');
      if (resource === null || !sameResource(resource, row.url)) return false; // the URL changed while a sign-in or refresh was in flight (or it is refused)
      const entry: StoredTokens = { tokens, savedAt: this.now(), resource };
      if (opts.signIn) this.bump(serverId);
      // Cached before the write, so a request racing this one already sends the new token.
      this.tokenCache.set(serverId, entry);
      await this.secrets.set(oauthRefs(serverId).tokens, JSON.stringify(entry));
      // The row was deleted or re-pointed while the write was in flight: take the entry back out rather than leave it behind.
      if (!sameResource(this.store.mcpServers.get(serverId)?.url, resource)) {
        if (this.tokenCache.get(serverId) === entry) this.tokenCache.set(serverId, null);
        await this.secrets.delete(oauthRefs(serverId).tokens);
        return false;
      }
      if (opts.signIn) this.patchSummary(serverId, { account: accountFromIdToken(tokens.id_token), signedInAt: entry.savedAt });
      return true;
    });
  }

  /** Starts a new generation and forgets the tokens. `generation` (background providers): dropped if older than the current one. */
  forgetTokens(serverId: string, opts: { generation?: number } = {}): Promise<void> {
    return this.serial(serverId, async () => {
      if (opts.generation !== undefined && opts.generation !== this.generation(serverId)) return;
      this.bump(serverId);
      this.tokenCache.set(serverId, null);
      await this.secrets.delete(oauthRefs(serverId).tokens);
      this.patchSummary(serverId, { account: null, signedInAt: null });
    });
  }

  /** The stored registration, or null (none, or one stored without an issuer by an earlier build). */
  async registeredClient(serverId: string): Promise<RegisteredClient | null> {
    const parsed = parseJson<unknown>(await this.secrets.get(oauthRefs(serverId).client));
    return isRegisteredClient(parsed) ? parsed : null;
  }

  saveRegisteredClient(serverId: string, entry: RegisteredClient): Promise<void> {
    return this.serial(serverId, async () => {
      if (!this.store.mcpServers.get(serverId)) return;
      await this.secrets.set(oauthRefs(serverId).client, JSON.stringify(entry));
    });
  }

  /** `generation` (background providers): dropped if older than the current one. */
  forgetRegisteredClient(serverId: string, opts: { generation?: number } = {}): Promise<void> {
    return this.serial(serverId, async () => {
      if (opts.generation !== undefined && opts.generation !== this.generation(serverId)) return;
      await this.secrets.delete(oauthRefs(serverId).client);
    });
  }

  /** The hand-registered client ("Sign-in app"), or null when Grunt registers itself. */
  async manualClient(serverId: string): Promise<ManualClient | null> {
    const oauth = this.store.mcpServers.get(serverId)?.oauth;
    if (!oauth?.clientId) return null;
    const secret = oauth.clientSecretRef ? await this.secrets.get(oauth.clientSecretRef) : null;
    return secret ? { client_id: oauth.clientId, client_secret: secret } : { client_id: oauth.clientId };
  }

  /** The Sign-in app. `secret`: undefined keeps the stored one, null deletes it, a string sets it. Clearing the client ID deletes the secret too. */
  async setManualClient(serverId: string, clientId: string | null, secret: string | null | undefined): Promise<void> {
    const ref = oauthRefs(serverId).clientSecret;
    let clientSecretRef = this.store.mcpServers.get(serverId)?.oauth?.clientSecretRef ?? null;
    if (clientId === null || secret === null) {
      await this.secrets.delete(ref);
      clientSecretRef = null;
    } else if (secret !== undefined) {
      await this.secrets.set(ref, secret);
      clientSecretRef = ref;
    }
    this.patchSummary(serverId, { clientId, clientSecretRef });
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

  private bump(serverId: string): void {
    this.generations.set(serverId, this.generation(serverId) + 1);
  }

  /** Runs one server's token and registration writes one after another. */
  private serial<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(serverId) ?? Promise.resolve();
    const run = previous.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.writeChains.set(serverId, tail);
    void tail.then(() => {
      if (this.writeChains.get(serverId) === tail) this.writeChains.delete(serverId);
    });
    return run;
  }

  private boundTo(serverId: string, entry: StoredTokens | null): StoredTokens | null {
    if (!entry) return null;
    const url = this.store.mcpServers.get(serverId)?.url;
    return typeof entry.resource === 'string' && sameResource(entry.resource, url) ? entry : null;
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
