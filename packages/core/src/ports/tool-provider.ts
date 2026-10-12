import type { Grant } from './store.js';
import type { ToolPolicy, ToolSource } from '../types/config.js';
import type { ResolvedFolder } from '../types/workspace.js';

/** Which sub-agent a tool call or approval card belongs to (spec 2026-10-12-api-subagents-design). */
export interface SubagentTag {
  /** The parent's `subagent` tool call id. */
  callId: string;
  /** The label the parent model gave it. */
  label: string;
  /**
   * The parent reply's profile id. The sub-agent's tool calls are matched
   * against, and any grant given on them is stored under, this profile, not
   * the one it runs as: a sub-agent can never do more than its parent.
   */
  parentProfileId: string;
  /** The profile it runs as, set only when that isn't the parent's own (for its approval cards). */
  profileName?: string;
}

/** Runs sub-agents for one reply. The `subagent` tool's `execute` hands its call here. */
export interface SubagentHost {
  run(input: unknown, ctx: ToolContext): Promise<unknown>;
}

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
   * different profile. For a sub-agent's call it is the PARENT reply's
   * profile (`SubagentTag.parentProfileId`), never the one it runs as.
   */
  profileId: string;
  workspaceRoot: string | null;
  /**
   * The chat's extra folders on this machine, each read-only or read & write
   * (spec 2026-10-07-extra-folders). Paths in them are absolute; a relative
   * path always means the workspace. Absent means none.
   */
  folders?: ResolvedFolder[];
  signal: AbortSignal;
  /** The model's id for this tool call, when the engine knows it. */
  toolCallId?: string;
  /** The reply's sub-agent runner; set only for a turn that offers the `subagent` tool. */
  subagents?: SubagentHost;
  /** Set on every call a sub-agent makes: whose call it is. */
  subagent?: SubagentTag;
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
  /** Set when a sub-agent's tool call raised this card. */
  subagent?: SubagentTag;
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

/** What `ToolProvider.requestApproval` decided for an externally executed tool call. */
export type ApprovalOutcome =
  | { allowed: true; grantedBy: string }
  | { allowed: false; reason: string }
  | { deferred: true };

/** Options for `ToolProvider.requestApproval`. */
export interface ApprovalOptions {
  /**
   * Claude Code auto mode: a call the broker would ask about is handed to
   * Claude Code's own classifier (`{ deferred: true }`) instead of raising a
   * card, when `isDeferrableInAutoMode` allows it. Deny/allow are unaffected.
   */
  deferAsk?: boolean;
}

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
  /** `decidedOnNode`: the paired machine the answer came from (its audit records it); this machine when omitted. */
  resolveApproval(requestId: string, choice: ApprovalChoice, decidedOnNode?: string): boolean;
  /**
   * The permission gate for a tool call that something else will execute
   * (Claude Code's own tools, `source: 'agent'`). Same decide -> approval card
   * -> resolve -> audit flow as a gated Grunt tool, minus the execution. This
   * is the only way an external agent's tool call may be authorised.
   */
  requestApproval(tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext, opts?: ApprovalOptions): Promise<ApprovalOutcome>;
  /**
   * Records a tool call Claude Code's auto-mode classifier blocked (its
   * PermissionDenied hook) as an audit row with grantedBy `deny:auto` and the
   * classifier's reason as the summary. Changes no decision. Never throws.
   */
  recordAgentDenial(ctx: ToolContext, toolName: string, args: unknown, reason: string): void;
}
