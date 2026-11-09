// --- mcp servers ----------------------------------------------------------------

/**
 * An http MCP server's sign-in summary (spec 2026-10-12-mcp-oauth-design §2).
 * Never a token or a secret value: tokens, registered clients and a
 * hand-registered client's secret live in `SecretStore` under
 * `mcp:<id>:oauth:*` (`McpOAuthStore`, packages/tools/src/mcp/oauth-store.ts).
 */
export interface McpServerOAuth {
  /** A client ID registered by hand with the server's sign-in provider. Null: OtherBench registers itself. */
  clientId: string | null;
  /** SecretStore reference of that client's secret, if it has one. Never the value. */
  clientSecretRef: string | null;
  /** "Signed in as …": from the provider's id_token, when it sends one. Display only. */
  account: string | null;
  /** When the current sign-in completed (ms). Null: not signed in. */
  signedInAt: number | null;
}

export interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  /**
   * `SecretStore` references, keyed by env var name -- NOT plaintext values.
   * A stdio server's environment variables are exactly as likely to carry a
   * credential as an HTTP server's headers (`headerRefs`, right below), so
   * this follows the identical "never plaintext at rest" discipline
   * `Connection.secretRef` established: the route layer
   * (routes/tools.ts) writes each value to `SecretStore` and persists only
   * the resulting reference here. Resolved back to real values only at
   * connect time (`McpServerManager.resolveTransportConfig`).
   */
  envRefs: Record<string, string>;
  url: string | null;
  headerRefs: Record<string, string>;
  enabled: boolean;
  status: 'unknown' | 'ok' | 'error';
  toolsCache: unknown;
  /** Null for stdio servers and for http servers that never signed in or set a client ID. */
  oauth: McpServerOAuth | null;
}

export interface McpServerRepo {
  create(s: McpServer): McpServer;
  get(id: string): McpServer | null;
  list(): McpServer[];
  update(id: string, patch: Partial<Omit<McpServer, 'id'>>): McpServer;
  delete(id: string): void;
}
