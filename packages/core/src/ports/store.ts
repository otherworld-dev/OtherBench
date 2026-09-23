import type { CanonMessage, MessageStatus, Part, SerializedError } from '../types/messages.js';
import type { Connection, ModelInfo, Profile, ToolSource } from '../types/config.js';
import type { PricingSnapshot } from '../types/usage.js';

// --- connections ---------------------------------------------------------

export interface ConnectionRepo {
  create(c: Connection): Connection;
  get(id: string): Connection | null;
  list(): Connection[];
  update(id: string, patch: Partial<Omit<Connection, 'id'>>): Connection;
  delete(id: string): void;
}

// --- models ----------------------------------------------------------------

export interface ModelRepo {
  create(m: ModelInfo): ModelInfo;
  get(id: string): ModelInfo | null;
  list(connectionId?: string): ModelInfo[];
  update(id: string, patch: Partial<Omit<ModelInfo, 'id'>>): ModelInfo;
  delete(id: string): void;
}

// --- profiles ----------------------------------------------------------------

export interface ProfileRepo {
  create(p: Profile): Profile;
  get(id: string): Profile | null;
  list(): Profile[];
  update(id: string, patch: Partial<Omit<Profile, 'id'>>): Profile;
  delete(id: string): void;
}

// --- chats ----------------------------------------------------------------

export interface Chat {
  id: string;
  title: string;
  profileId: string;
  headMessageId: string | null;
  workspaceRoot: string | null;
  pinned: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChatRepo {
  create(c: Omit<Chat, 'createdAt' | 'updatedAt'> & { createdAt?: number; updatedAt?: number }): Chat;
  get(id: string): Chat | null;
  list(): Chat[];
  update(id: string, patch: Partial<Omit<Chat, 'id'>>): Chat;
  delete(id: string): void;
}

// --- messages ----------------------------------------------------------------

export interface MessageRepo {
  create(m: Omit<CanonMessage, 'createdAt'> & { createdAt?: number }): CanonMessage;
  get(id: string): CanonMessage | null;
  children(parentId: string): CanonMessage[];
  roots(chatId: string): CanonMessage[];
  pathToRoot(messageId: string): CanonMessage[];   // ordered root -> leaf
  updateParts(id: string, parts: Part[]): void;
  updateStatus(id: string, status: MessageStatus, error?: SerializedError | null): void;
  searchText(query: string, limit: number): { messageId: string; chatId: string; snippet: string }[];
  /**
   * Every message across every chat currently at `status`, in no particular
   * order. Exists for startup reconciliation (see
   * `domain/reconcile.ts`'s `reconcileInterruptedTurns`), which needs to
   * find every orphaned `streaming` row without walking each chat's message
   * tree one at a time via `roots`/`children`.
   */
  listByStatus(status: MessageStatus): CanonMessage[];
}

// --- attachments ----------------------------------------------------------------

export interface Attachment {
  id: string;
  chatId: string;
  messageId: string | null;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  storagePath: string;
  extractedText: string | null;
}

export interface AttachmentRepo {
  create(a: Attachment): Attachment;
  get(id: string): Attachment | null;
  list(chatId: string): Attachment[];
  update(id: string, patch: Partial<Omit<Attachment, 'id'>>): Attachment;
  delete(id: string): void;
  /**
   * True if at least one attachment row (in any chat -- upload dedupes by
   * content hash, so the same blob can be referenced from several chats,
   * see `BlobStore`) still has this sha256. Used by the blob GC sweep
   * (`@grunt/store-sqlite/blob-gc.js`) to decide whether a blob on disk is
   * garbage: a blob is only ever removed once nothing references it.
   */
  isReferenced(sha256: string): boolean;
  /**
   * Every distinct sha256 referenced by at least one attachment row, across
   * every chat. Used by the startup blob sweep, which walks what is
   * physically on disk and needs the full referenced set to diff against --
   * see `@grunt/store-sqlite/blob-gc.js`'s `sweepOrphanedBlobs`.
   */
  referencedShas(): Set<string>;
}

/**
 * The subset of `Attachment` ever serialised to a client (task 32 decision
 * #3): `storagePath` is a raw SERVER filesystem path -- the client has no
 * use for it (attachment bytes are always fetched via
 * `GET /attachments/:id/content`, never a filesystem path) and it should
 * never leave the server. `storagePath` stays on the full `Attachment` type
 * (and in the database) because the server itself needs it (`BlobStore.get`/
 * `remove`); every route response strips it down to this shape instead --
 * see `routes/attachments.ts`'s `toPublicAttachment`. The web client's own
 * `Attachment`-shaped state should be typed as this, not the full row, since
 * this is all it will ever actually receive.
 */
export type PublicAttachment = Omit<Attachment, 'storagePath'>;

// --- usage ----------------------------------------------------------------

export interface UsageRecord {
  id: string;
  chatId: string;
  messageId: string;
  profileId: string;
  connectionId: string;
  modelId: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  costEstimate: number | null;
  pricingSnapshot: PricingSnapshot;
  latencyMs: number;
}

export interface UsageRepo {
  create(u: UsageRecord): UsageRecord;
  get(id: string): UsageRecord | null;
  list(chatId: string): UsageRecord[];
  update(id: string, patch: Partial<Omit<UsageRecord, 'id'>>): UsageRecord;
  delete(id: string): void;
}

// --- mcp servers ----------------------------------------------------------------

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
}

export interface McpServerRepo {
  create(s: McpServer): McpServer;
  get(id: string): McpServer | null;
  list(): McpServer[];
  update(id: string, patch: Partial<Omit<McpServer, 'id'>>): McpServer;
  delete(id: string): void;
}

// --- grants ----------------------------------------------------------------

export interface Grant {
  id: string;
  chatId: string | null;
  /**
   * The profile the grant was made under, or `null` for a grant that is
   * deliberately not profile-scoped. `PermissionBroker` always stamps the
   * calling profile's id here; `null` matches every profile and exists only
   * for grants created outside the broker (fixtures, hand-written rows).
   */
  profileId: string | null;
  toolName: string;
  /**
   * The `ToolSpec.source` of the tool this grant was made for. Matched
   * alongside `toolName`, never instead of it: keying on the name alone let
   * a tool from one source (say, one an MCP server chose to call
   * `run_command`) obtain a grant that a completely different tool with the
   * same name then satisfied.
   */
  source: ToolSource;
  scope: 'once' | 'chat' | 'always';
  /**
   * Narrows what the grant authorises. `null` means "no narrowing" -- only
   * ever valid for non-shell tools; `PermissionBroker` refuses to create an
   * unconstrained grant of any scope for the shell.
   *
   * - `pathPrefix`: matched against the RESOLVED path (`containPath`), not
   *   the raw argument, so `..` cannot walk out of the granted subtree.
   * - `commandPrefix`: argv-prefix match, no shell metacharacters. Broad --
   *   see `commandPrefixMatches` in domain/permissions.ts for exactly how
   *   broad, and why.
   * - `commandExact`: the command must equal this string exactly (modulo
   *   surrounding whitespace). What a `'chat'`-scope shell approval is
   *   stored as.
   *
   * Persisted as a JSON blob (`"constraint"` TEXT), so adding a key here
   * needs no migration.
   */
  constraint: { pathPrefix?: string; commandPrefix?: string; commandExact?: string } | null;
  expiresAt: number | null;
}

export interface GrantRepo {
  create(g: Grant): Grant;
  get(id: string): Grant | null;
  list(chatId?: string): Grant[];
  update(id: string, patch: Partial<Omit<Grant, 'id'>>): Grant;
  delete(id: string): void;
}

// --- audit ----------------------------------------------------------------

export interface AuditEntry {
  id: string;
  chatId: string;
  messageId: string;
  toolName: string;
  argsRedacted: unknown;
  resultSummary: string;
  durationMs: number;
  grantedBy: string;
  createdAt: number;
}

export interface AuditRepo {
  create(a: Omit<AuditEntry, 'createdAt'> & { createdAt?: number }): AuditEntry;
  get(id: string): AuditEntry | null;
  list(chatId: string): AuditEntry[];
  update(id: string, patch: Partial<Omit<AuditEntry, 'id'>>): AuditEntry;
  delete(id: string): void;
}

// --- store ----------------------------------------------------------------

export interface Store {
  connections: ConnectionRepo;
  models: ModelRepo;
  profiles: ProfileRepo;
  chats: ChatRepo;
  messages: MessageRepo;
  attachments: AttachmentRepo;
  usage: UsageRepo;
  mcpServers: McpServerRepo;
  grants: GrantRepo;
  audit: AuditRepo;
  close(): void;
}
