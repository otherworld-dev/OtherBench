import type { ToolSource } from '../../types/config.js';

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
   * - `host`: one host, for a `sandbox_network` grant (`source: 'network'`)
   *   or a browser grant (`source: 'browser'`, spec
   *   2026-10-12-model-browser-design): exact on the canonical spelling (so
   *   case-insensitive), any port, never a subdomain. Every network and
   *   browser grant carries one; one without never matches. The grant's
   *   source is part of the match: a browser grant never covers the sandbox's
   *   network, and a network grant never covers the browser.
   *
   * - `live`: a live artifact's call (spec 2026-10-12-live-artifacts): only
   *   `PermissionBroker.grantLive` makes one, only a live call
   *   (`ToolContext.live`) can match it, and it matches nothing else.
   *   `serverId` is the MCP server the tool came from when it was allowed,
   *   so a server renamed or replaced into the tool's name doesn't inherit
   *   it. Grants stored before it existed have none and never match.
   *
   * - `app`: computer use's target app (`source: 'computer'`, spec
   *   2026-10-12-computer-use-design): its key, the program's canonical
   *   path exactly as the desktop shell resolved it (`appKey`,
   *   domain/computer-apps.ts, checks it and never changes it). Matched with
   *   `===`, never by name, case-folding or prefix, so `Downloads\EXCEL.EXE`
   *   can't ride on Excel's grant. A stored value that isn't a valid key
   *   matches nothing. A grant of one source never covers another: an `app`
   *   is only ever matched for a computer call, a `host` only for a network
   *   or browser call.
   *
   * Persisted as a JSON blob (`"constraint"` TEXT), so adding a key here
   * needs no migration.
   */
  constraint: {
    pathPrefix?: string;
    commandPrefix?: string;
    commandExact?: string;
    host?: string;
    app?: string;
    live?: { artifactId: string; callId: string; hash: string; serverId: string };
  } | null;
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
  /** The machine the decision was made on (v2 spec §3): this one unless approved from a paired machine. Filled in by the store when not given. */
  decidedOnNode?: string;
  createdAt: number;
}

export interface AuditRepo {
  create(a: Omit<AuditEntry, 'createdAt'> & { createdAt?: number }): AuditEntry;
  get(id: string): AuditEntry | null;
  list(chatId: string): AuditEntry[];
  update(id: string, patch: Partial<Omit<AuditEntry, 'id'>>): AuditEntry;
  delete(id: string): void;
}
