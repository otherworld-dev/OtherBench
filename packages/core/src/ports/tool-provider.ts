import type { Grant } from './store.js';
import type { ToolPolicy, ToolSource } from '../types/config.js';

export type RiskClass = 'read' | 'mutate' | 'execute';

export interface ToolContext {
  chatId: string;
  messageId: string;
  /**
   * The profile this turn is running under (`ResolvedProfile.id`). Present
   * because tool permission is a per-PROFILE property: the project-wide rule
   * is "shell is default-deny per profile with per-command approval", and a
   * grant recorded without a profile silently applied under every profile,
   * so approving a command while using a locked-down profile also approved
   * it for a permissive one. `PermissionBroker` stamps every grant it
   * creates with this id and refuses to match a grant belonging to a
   * different profile.
   */
  profileId: string;
  workspaceRoot: string | null;
  signal: AbortSignal;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema
  risk: RiskClass;
  source: ToolSource;
  /**
   * For `source: 'mcp'`, the id of the MCP server this tool came from --
   * i.e. the id that appears (or does not) in `ToolPolicy.mcpServerIds`.
   * Required in practice for MCP tools: `PermissionBroker` denies an MCP
   * tool that does not declare one, because without it the policy gate can
   * only check that SOME server is enabled, not that THIS tool's server is,
   * and a tool from a server the user never enabled would be auto-allowed.
   * Undefined for built-in fs/shell tools, which have no server.
   */
  serverId?: string;
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
}

/**
 * Raised by a gated `ToolSpec` (task 26's `ToolProvider` implementation,
 * `@grunt/tools`'s `provider.ts`) when `PermissionBroker.decide()` returns
 * `'ask'` for a call. Defined here, on the port, rather than alongside
 * `PermissionBroker` in `@grunt/core/domain/permissions.ts`, specifically so
 * this file can be depended on by BOTH the domain layer (which already
 * imports `RiskClass`/`ToolContext`/`ToolSpec` from here) and by anything
 * needing to reference the shape of an approval event without importing the
 * broker itself -- `domain/permissions.ts` imports `ApprovalRequest` back
 * from here rather than defining it locally, so there is exactly one
 * definition and no import cycle between a port and the domain layer that
 * depends on it.
 */
export interface ApprovalRequest {
  id: string;
  chatId: string;
  messageId: string;
  toolName: string;
  risk: RiskClass;
  source: ToolSpec['source'];
  args: unknown;
  summary: string;
}

/** The human's answer to a previously-issued `ApprovalRequest`, as `PermissionBroker.resolve()` consumes it. */
export type ApprovalChoice =
  | { choice: 'deny' }
  | { choice: 'once' }
  | { choice: 'chat' }
  | { choice: 'always'; constraint: Grant['constraint'] };

/**
 * The approval lifecycle events a `ToolProvider`'s gated tools raise, fanned
 * out via `onApprovalEvent` so a caller (the `TurnRunner`) can relay them as
 * `TurnEvent`s tagged with the request's own `messageId` -- this is what
 * makes an approval prompt block only the one variant that raised it (task
 * 26 decision #2): every event already carries the `messageId` it belongs
 * to, so nothing about the relay path needs to track "whose turn is this"
 * itself.
 */
export type ToolApprovalEvent =
  | { type: 'request'; request: ApprovalRequest }
  | { type: 'resolved'; requestId: string; messageId: string; choice: ApprovalChoice['choice'] };

export interface ToolProvider {
  listTools(policy: ToolPolicy): Promise<ToolSpec[]>;
  refreshMcp(serverId: string): Promise<void>;
  shutdown(): Promise<void>;
  /** Subscribes to every approval-lifecycle event raised by this provider's gated tools, across every chat/turn. Returns an unsubscribe function. */
  onApprovalEvent(cb: (event: ToolApprovalEvent) => void): () => void;
  /**
   * Answers a still-pending `ApprovalRequest` raised by a gated tool call --
   * the server-side counterpart of a human clicking Approve/Deny in the UI
   * (routes/tools.ts's `POST /approvals/:id/resolve`). Returns `false`
   * (never throws) for an unknown or already-resolved request id, e.g. a
   * stale double-submit or a request that was already implicitly denied by
   * its turn being cancelled.
   */
  resolveApproval(requestId: string, choice: ApprovalChoice): boolean;
}
