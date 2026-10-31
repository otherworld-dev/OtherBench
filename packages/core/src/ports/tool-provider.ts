import type { Grant, LiveCall } from './store.js';
import type { ToolPolicy, ToolSource } from '../types/config.js';
import type { ResolvedFolder } from '../types/workspace.js';
import type { AskAnswerResult, AskInput, AskOutcome, AskReply, PlanGate, UserAsk } from '../types/thread.js';
import type { MediaProgress } from './media.js';
export type { AskAnswerResult, AskInput, AskOutcome, AskReply, PlanGate, UserAsk } from '../types/thread.js';

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

/**
 * Which declared call of which artifact version a live call is, by its
 * declaration's hash, and the id of the MCP server its tool comes from now
 * (spec 2026-10-12-live-artifacts). The server id is always the provider's
 * own lookup, never anything the page sent.
 */
export type LiveCallRef = NonNullable<NonNullable<Grant['constraint']>['live']>;

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
  /**
   * This reply's plan approval (spec 2026-10-12-thread-cards-design §4), set
   * only while the chat's Plan mode is on. Until it is approved,
   * `PermissionBroker.decide` refuses anything that could change something.
   */
  plan?: PlanGate;
  /**
   * Nobody can answer a card for this call: a scheduled run (spec
   * 2026-10-12-scheduled-tasks-design). Questions and plans are answered for
   * the model and never raise a card; any other call that would ask is refused
   * with `approval_unavailable` instead of waiting (the sandbox's network
   * cards included, spec 2026-10-12-sandbox-design "Unattended runs"). Set
   * only by the schedule service, through `TurnInput.unattended`; it can only
   * take permissions away.
   */
  unattended?: boolean;
  /**
   * With `unattended`: the schedule allows Claude Code's auto mode, so a
   * `deferAsk` call is handed to the classifier (or, for OtherBench's own
   * tools, approved) as it would be with someone there. Anything that still
   * asks is refused as unattended. Set only by `toolContextFor`, from
   * `TurnInput.unattendedAuto` by way of the request's `autoMode`.
   */
  unattendedAuto?: boolean;
  /**
   * Set only by `OtherBenchToolProvider.runLiveCall`, never by an engine or
   * `toolContextFor`: this call is one a live artifact's page asked for (spec
   * 2026-10-12-live-artifacts). `PermissionBroker.decide` then takes its live
   * branch, which allows only a live grant for exactly this call.
   */
  live?: LiveCallRef;
  signal: AbortSignal;
  /** The model's id for this tool call, when the engine knows it. */
  toolCallId?: string;
  /** The reply's sub-agent runner; set only for a turn that offers the `subagent` tool. */
  subagents?: SubagentHost;
  /** Set on every call a sub-agent makes: whose call it is. */
  subagent?: SubagentTag;
  /**
   * The helper an engine's own agent started that made this call (Claude
   * Code's Task or Agent tool), shown on its approval card. Unlike
   * `subagent`, it changes no decision for most tools: the call is the
   * reply's own as far as policy and grants go. Media generation is the
   * exception: a helper's generate call is refused.
   */
  shownSubagent?: SubagentTag;
}

/**
 * What `ToolSpec.describeCall` makes of a call before the broker decides
 * (spec 2026-10-12-model-browser-design §1): the arguments the broker, the
 * card, the audit and `execute` all see, and this call's risk; or a refusal,
 * which ends the call with no card.
 */
export type DescribedCall = { args: Record<string, unknown>; risk: RiskClass } | { refuse: string };

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
  /**
   * Works out what a call will act on before the broker decides. The provider
   * calls it first (provider.ts `gate()` and `requestApproval()`); the broker
   * then decides on `{ ...spec, risk }` with the described arguments, and
   * `execute` receives those, never the raw ones. Specs without it are
   * decided on their raw arguments, as before. The browser uses it to name
   * the website a call touches; a `host` the model sent is thrown away.
   */
  describeCall?(args: unknown, ctx: ToolContext): Promise<DescribedCall>;
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
}

/**
 * Raised by a gated `ToolSpec` (task 26's `ToolProvider` implementation,
 * `@otherbench/tools`'s `provider.ts`) when `PermissionBroker.decide()` returns
 * `'ask'` for a call. Defined here, on the port, rather than alongside
 * `PermissionBroker` in `@otherbench/core/domain/permissions.ts`, specifically so
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
  | { type: 'resolved'; requestId: string; messageId: string; choice: ApprovalChoice['choice'] }
  /** A question or plan card for the user (spec 2026-10-12-thread-cards-design), tied to `ask.messageId`. */
  | { type: 'ask'; ask: UserAsk }
  /** That ask ended, however: answered, the turn stopped, or the backstop dropped it. */
  | { type: 'ask-resolved'; askId: string; messageId: string }
  /** How far a generation call has got (the media tools), by its tool call id. Throttled by the tool; never stored. */
  | { type: 'progress'; messageId: string; callId: string; progress: MediaProgress };

/** What `ToolProvider.requestApproval` decided for an externally executed tool call. */
export type ApprovalOutcome =
  /** `args`: the described arguments, when the spec has `describeCall` (the Claude Code gate keeps them as a ticket). */
  | { allowed: true; grantedBy: string; args?: unknown }
  /**
   * `about`: the line that says whose words `reason` may hold, when they may
   * not be OtherBench's (a computer call refused in the desktop app's words:
   * `COMPUTER_SCREEN_ABOUT`). Whoever passes the reason on to a model puts
   * this line first; it is not part of the reason a person is shown.
   */
  | { allowed: false; reason: string; about?: string }
  | { deferred: true };

/**
 * What a call is answered with when it comes to be run and no approval
 * stands behind it: on Claude Code's path, a relayed call with no ticket
 * (engine-claude-code `runRelayed`) and one the tool provider did not approve
 * for that chat and reply (`OtherBenchToolProvider.runRelayedCall`); in the
 * browser tool, arguments that carry no approved site. One sentence for all
 * three, so the model reads the same thing whichever of them refused.
 */
export const NO_APPROVAL_REASON = 'OtherBench has no approval for this call.';

/** Options for `ToolProvider.requestApproval`. */
export interface ApprovalOptions {
  /**
   * Claude Code auto mode: a call the broker would ask about raises no card.
   * A Claude Code tool is handed to its own classifier (`{ deferred: true }`,
   * `isDeferrableInAutoMode`); one of OtherBench's own tools is approved
   * (grantedBy `auto`). Deny/allow are unaffected, and an unattended run
   * still refuses what it would have asked about, unless its schedule allows
   * auto mode (`ToolContext.unattendedAuto`).
   */
  deferAsk?: boolean;
}

/** One declared call of a live page, as the viewer's panel shows it (spec 2026-10-12-live-artifacts). */
export interface LiveCallStatus {
  callId: string;
  /** The namespaced MCP name, `mcp__<server>__<tool>`. */
  tool: string;
  serverName: string;
  toolName: string;
  /** The server's description of the tool, at most 300 characters, shown as plain text. */
  description: string;
  state: 'allowed' | 'needs_ok' | 'unavailable';
  /** Why it is unavailable. */
  reason?: string;
}

export type LiveCallFailure = 'not_approved' | 'refused' | 'not_available' | 'rate_limited' | 'timeout' | 'tool_error' | 'failed' | 'too_large';

/** What a live call came back as: data for the page, or why not. */
export type LiveCallOutcome =
  | { ok: true; text: string; json?: unknown; structured?: unknown; cached: boolean; at: number }
  | { ok: false; code: LiveCallFailure; message: string };

/** A live page's calls, for its status or to allow them: each declared call with its declaration hash. */
export interface LiveStatusRequest {
  chatId: string;
  profileId: string;
  policy: ToolPolicy;
  artifactId: string;
  calls: { call: LiveCall; hash: string }[];
}

/** One live call to run. `args` are already built from the stored declaration (never from the page). */
export interface LiveRunRequest {
  chatId: string;
  /** The version's reply: audit rows point at it. */
  messageId: string;
  profileId: string;
  policy: ToolPolicy;
  artifactId: string;
  callId: string;
  hash: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Skip the cache and replace its entry (Refresh). */
  fresh: boolean;
  signal: AbortSignal;
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
   * -> resolve -> audit flow as a gated OtherBench tool, minus the execution. This
   * is the only way an external agent's tool call may be authorised.
   */
  requestApproval(tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext, opts?: ApprovalOptions): Promise<ApprovalOutcome>;
  /**
   * Records a tool call Claude Code's auto-mode classifier blocked (its
   * PermissionDenied hook) as an audit row with grantedBy `deny:auto` and the
   * classifier's reason as the summary. Changes no decision. Never throws.
   */
  recordAgentDenial(ctx: ToolContext, toolName: string, args: unknown, reason: string): void;
  /**
   * Puts a question or a plan to the user and waits (spec
   * 2026-10-12-thread-cards-design): raises an `ask` event, then settles on
   * `answerAsk`, on the turn's signal, or at once with `{ unattended: true }`
   * when `ctx.unattended` is set (no event at all then).
   */
  askUser(ctx: ToolContext, input: AskInput): Promise<AskOutcome>;
  /** Answers a pending ask: `'unknown'` for an unknown or settled id, `{ invalid }` for a reply that doesn't fit it. Never throws. */
  answerAsk(askId: string, reply: AskReply): AskAnswerResult;
  /** Live artifacts (spec 2026-10-12-live-artifacts): each declared call's state for the viewer's panel. */
  liveStatus(req: LiveStatusRequest): LiveCallStatus[];
  /** Grants the calls that need an OK (PermissionBroker.grantLive), then returns the status again. */
  allowLive(req: LiveStatusRequest): LiveCallStatus[];
  /** Stop live data: removes the chat's live grants for the artifact. Returns how many. */
  revokeLive(chatId: string, artifactId: string): number;
  /** Runs one live call through the broker's live branch, the cache and the limits. Never throws. */
  runLiveCall(req: LiveRunRequest): Promise<LiveCallOutcome>;
}
