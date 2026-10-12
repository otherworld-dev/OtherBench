import type { SecretStore } from '@grunt/core/ports/secret-store.js';
import type { McpServer, Store } from '@grunt/core/ports/store.js';
import { McpClient, type McpClientOptions, type McpTransportConfig } from './client.js';
import { GruntOAuthProvider, hasAuthorizationHeader } from './oauth-provider.js';
import { McpOAuthStore } from './oauth-store.js';

/** One http server's sign-in, as the browser sees it: never a token, code or secret. */
export interface McpServerAuthHealth {
  /** `needs_sign_in` when the live status is needs_auth; else `signed_in` when a sign-in completed; else `none`. */
  state: 'none' | 'needs_sign_in' | 'signed_in';
  account: string | null;
  signedInAt: number | null;
  /** A sign-in started here is waiting for the browser. */
  pending: boolean;
  /** Why the last sign-in failed, until the next start. */
  error: string | null;
}

export interface McpServerHealth {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  enabled: boolean;
  /** 'connecting' and 'needs_auth' only exist live, in-memory -- the persisted `McpServer.status` column has neither (see `persistedStatus` below), so a fresh page load between (re)connect attempts reports whatever was last durably written instead. */
  status: 'unknown' | 'connecting' | 'ok' | 'error' | 'needs_auth';
  lastError: string | null;
  toolCount: number;
  /** Null for stdio servers and for http servers with a fixed Authorization header. */
  auth: McpServerAuthHealth | null;
}

export interface McpOAuthOptions {
  /** Clock for token save times, the refresh grace and sign-in expiry. Tests advance it. */
  now?: () => number;
  /** How long a started sign-in waits for the browser. Default 600_000 (10 minutes). */
  signInTimeoutMs?: number;
  /** Timeout for each HTTP request made while starting or finishing a sign-in. Default 15_000. */
  requestTimeoutMs?: number;
}

function persistedStatus(status: McpClient['status']): McpServer['status'] {
  if (status === 'connecting') return 'unknown';
  if (status === 'needs_auth') return 'error';
  return status;
}

/**
 * Owns one live `McpClient` per ENABLED `mcp_server` row, and keeps that
 * row's `status`/`toolsCache` columns in step with the client's own
 * observed state. `Store` has no change-notification mechanism, so this is
 * driven by explicit `sync()` calls (at server startup, and by the CRUD
 * route in routes/tools.ts right after any write to `mcp_server`) rather
 * than polling the table -- "connect on enable" (task 25/26 brief) means
 * exactly this: enabling a server is a write the route already knows about,
 * so it can just ask the manager to reconcile immediately afterward.
 *
 * Also owns sign-in state (spec 2026-10-12-mcp-oauth-design §4): one
 * `McpOAuthStore`, and a background `GruntOAuthProvider` on every http
 * connection without a fixed Authorization header.
 */
export class McpServerManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly unsubscribes = new Map<string, () => void>();
  private readonly oauth: McpOAuthStore;

  constructor(
    private readonly store: Store,
    private readonly secrets: SecretStore,
    private readonly clientOptions: McpClientOptions = {},
    private readonly oauthOptions: McpOAuthOptions = {}
  ) {
    this.oauth = new McpOAuthStore(store, secrets, oauthOptions.now);
  }

  async sync(): Promise<void> {
    const rows = this.store.mcpServers.list();
    const rowById = new Map(rows.map((r) => [r.id, r]));

    const disconnecting: Promise<void>[] = [];
    for (const [id, client] of [...this.clients]) {
      const row = rowById.get(id);
      if (!row || !row.enabled) {
        this.teardown(id);
        disconnecting.push(client.disconnect());
      }
    }
    await Promise.all(disconnecting);

    for (const row of rows) {
      if (!row.enabled || this.clients.has(row.id)) continue;
      await this.connectServer(row);
    }
  }

  /** Forces an immediate reconnect + tool re-list for one server, bypassing any pending backoff. A no-op if the server isn't currently enabled/connected. */
  async refresh(serverId: string): Promise<void> {
    await this.clients.get(serverId)?.refresh();
  }

  /**
   * Tears one server's connection down and connects again from its CURRENT
   * row, so a changed URL, headers, command, args, env or sign-in provider
   * takes effect (`refresh()` reuses the config the client was built with).
   * Connects only if the row still exists and is enabled.
   */
  async restart(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      this.teardown(serverId);
      await client.disconnect();
    }
    const row = this.store.mcpServers.get(serverId);
    if (row?.enabled) await this.connectServer(row);
  }

  /** Every currently-connected client among `serverIds`, paired with its row's own name (used for `mcp__<name>__<tool>` namespacing). Unknown/not-yet-connected ids are silently omitted -- a policy naming a server that hasn't connected yet simply contributes no tools this call, rather than erroring the whole turn. A server that needs sign-in isn't `ok`, so it offers no tools. */
  listFor(serverIds: string[]): { id: string; name: string; client: McpClient }[] {
    const rows = new Map(this.store.mcpServers.list().map((r) => [r.id, r]));
    const out: { id: string; name: string; client: McpClient }[] = [];
    for (const id of serverIds) {
      const client = this.clients.get(id);
      const row = rows.get(id);
      if (!client || !row || client.status !== 'ok') continue;
      out.push({ id, name: row.name, client });
    }
    return out;
  }

  /** Every configured server's live health, for the Inspector -- includes disabled/never-connected rows too, so "this server exists but is off" is visible, not silently omitted. */
  health(): McpServerHealth[] {
    return this.store.mcpServers.list().map((row) => {
      const client = this.clients.get(row.id);
      const status = client?.status ?? row.status;
      return {
        id: row.id,
        name: row.name,
        transport: row.transport,
        enabled: row.enabled,
        status,
        lastError: client?.lastError ?? null,
        toolCount: client?.tools.length ?? (Array.isArray(row.toolsCache) ? row.toolsCache.length : 0),
        auth: this.authHealth(row, status),
      };
    });
  }

  async shutdown(): Promise<void> {
    const clients = [...this.clients.values()];
    for (const id of [...this.clients.keys()]) this.teardown(id);
    await Promise.all(clients.map((c) => c.disconnect()));
  }

  private authHealth(row: McpServer, status: McpServerHealth['status']): McpServerAuthHealth | null {
    if (row.transport !== 'http' || hasAuthorizationHeader(row)) return null;
    const signedInAt = row.oauth?.signedInAt ?? null;
    return {
      state: status === 'needs_auth' ? 'needs_sign_in' : signedInAt !== null ? 'signed_in' : 'none',
      account: row.oauth?.account ?? null,
      signedInAt,
      pending: false,
      error: null,
    };
  }

  private async connectServer(row: McpServer): Promise<void> {
    let config: McpTransportConfig;
    try {
      config = await this.resolveTransportConfig(row);
    } catch (err) {
      this.store.mcpServers.update(row.id, { status: 'error' });
      console.error(`[McpServerManager] "${row.name}" (${row.id}) is misconfigured, not connecting:`, err);
      return;
    }

    const client = new McpClient(row.id, config, this.clientOptions);
    this.clients.set(row.id, client);
    const unsubscribe = client.onStatusChange((status) => {
      this.store.mcpServers.update(row.id, {
        status: persistedStatus(status),
        ...(status === 'ok' ? { toolsCache: client.tools } : {}),
      });
    });
    this.unsubscribes.set(row.id, unsubscribe);
    void client.connect();
  }

  private teardown(id: string): void {
    this.unsubscribes.get(id)?.();
    this.unsubscribes.delete(id);
    this.clients.delete(id);
  }

  private async resolveTransportConfig(row: McpServer): Promise<McpTransportConfig> {
    if (row.transport === 'stdio') {
      if (!row.command) {
        throw new Error(`MCP server "${row.name}" (${row.id}) has transport "stdio" but no command configured.`);
      }
      // `envRefs` stores SecretStore references, never the env values
      // themselves -- same discipline as `headerRefs` below. A ref that
      // fails to resolve is dropped from the outgoing environment rather
      // than failing the whole connection, for the same reason the http
      // branch drops an unresolvable header: the child process will surface
      // its own error if that variable was actually required.
      const env = await this.resolveSecretRefs(row.envRefs);
      return { transport: 'stdio', command: row.command, args: row.args, env };
    }

    if (!row.url) {
      throw new Error(`MCP server "${row.name}" (${row.id}) has transport "http" but no url configured.`);
    }
    // `headerRefs` stores SecretStore references, never header values
    // themselves -- the same "never plaintext in SQLite" discipline
    // Connection.secretRef already follows (see profile-resolution.ts).
    const headers = await this.resolveSecretRefs(row.headerRefs);
    // Sign-in is detected, not switched on: every http server without a fixed Authorization header gets the provider. A server that never answers 401 never asks it for anything.
    if (hasAuthorizationHeader(row)) return { transport: 'http', url: row.url, headers };
    return { transport: 'http', url: row.url, headers, authProvider: new GruntOAuthProvider(row.id, this.oauth, { kind: 'background' }) };
  }

  /** Resolves a `{name: secretRef}` map (`envRefs` or `headerRefs`) to `{name: value}`, silently dropping any ref that fails to resolve (see the two call sites above for why that's the right failure mode here). */
  private async resolveSecretRefs(refs: Record<string, string>): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const [name, ref] of Object.entries(refs)) {
      const value = await this.secrets.get(ref);
      if (value !== null) resolved[name] = value;
    }
    return resolved;
  }
}
