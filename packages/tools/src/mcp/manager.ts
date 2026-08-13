import type { SecretStore } from '@grunt/core/ports/secret-store.js';
import type { McpServer, Store } from '@grunt/core/ports/store.js';
import { McpClient, type McpClientOptions, type McpTransportConfig } from './client.js';

export interface McpServerHealth {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  enabled: boolean;
  /** 'connecting' only exists live, in-memory -- the persisted `McpServer.status` column has no such state (see `persistedStatus` below), so a fresh page load between (re)connect attempts reports whatever was last durably written instead. */
  status: 'unknown' | 'connecting' | 'ok' | 'error';
  lastError: string | null;
  toolCount: number;
}

function persistedStatus(status: McpClient['status']): McpServer['status'] {
  return status === 'connecting' ? 'unknown' : status;
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
 */
export class McpServerManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly unsubscribes = new Map<string, () => void>();

  constructor(
    private readonly store: Store,
    private readonly secrets: SecretStore,
    private readonly clientOptions: McpClientOptions = {}
  ) {}

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

  /** Every currently-connected client among `serverIds`, paired with its row's own name (used for `mcp__<name>__<tool>` namespacing). Unknown/not-yet-connected ids are silently omitted -- a policy naming a server that hasn't connected yet simply contributes no tools this call, rather than erroring the whole turn. */
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
      return {
        id: row.id,
        name: row.name,
        transport: row.transport,
        enabled: row.enabled,
        status: client?.status ?? row.status,
        lastError: client?.lastError ?? null,
        toolCount: client?.tools.length ?? (Array.isArray(row.toolsCache) ? row.toolsCache.length : 0),
      };
    });
  }

  async shutdown(): Promise<void> {
    const clients = [...this.clients.values()];
    for (const id of [...this.clients.keys()]) this.teardown(id);
    await Promise.all(clients.map((c) => c.disconnect()));
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
    return { transport: 'http', url: row.url, headers };
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
