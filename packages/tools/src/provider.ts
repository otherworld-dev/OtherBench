/**
 * The tool provider: the one way any engine reaches a tool, every call going
 * through `PermissionBroker` (`OtherBenchToolProvider`, below). Everything
 * else imports it from here.
 *
 * The provider assembles the tool families and owns the decide/run path;
 * the rest lives in `./provider/`, one concern per module:
 *
 *   - `outcomes.ts`: what a call can end in (`Authorization`, `Denied`), the
 *     provider's own refusal sentences and the error result;
 *   - `approvals.ts`: the approval round-trip, from a broker 'ask' to a card
 *     and back to `broker.resolve()`;
 *   - `audit.ts`: what an audit row keeps, and writing it;
 *   - `mcp-tools.ts`: the MCP servers' tools as specs, the lookups a live
 *     call needs, and name deduplication;
 *   - `live.ts`: live artifacts' calls.
 */
import { randomUUID } from 'node:crypto';
import { artifactTool, liveToolRisks } from './artifact-tool.js';
import { recallTool } from './recall-tool.js';
import { cardLine } from '@otherbench/core/domain/card-text.js';
import { COMPUTER_LIMITS, COMPUTER_OFF_REASON, COMPUTER_UNATTENDED_REASON, isUnattendedRun, screenContentError } from '@otherbench/core/domain/computer-apps.js';
import { allowedWhilePlanning, isDeferrableInAutoMode, PermissionBroker, type Decision } from '@otherbench/core/domain/permissions.js';
import { PLAN_REFUSAL } from '@otherbench/core/domain/thread-tools.js';
import { UserAsks } from '@otherbench/core/domain/user-asks.js';
import type { ComputerDriver } from '@otherbench/core/ports/computer.js';
import type { MediaProgress } from '@otherbench/core/ports/media.js';
import {
  NO_APPROVAL_REASON,
  type ApprovalChoice,
  type ApprovalOptions,
  type ApprovalOutcome,
  type AskAnswerResult,
  type AskInput,
  type AskOutcome,
  type AskReply,
  type LiveCallOutcome,
  type LiveCallStatus,
  type LiveRunRequest,
  type LiveStatusRequest,
  type ToolApprovalEvent,
  type ToolContext,
  type ToolProvider,
  type ToolSpec,
} from '@otherbench/core/ports/tool-provider.js';
import type { Sandbox } from '@otherbench/core/ports/sandbox.js';
import type { Store } from '@otherbench/core/ports/store.js';
import { canonicalHost } from '@otherbench/core/domain/network-hosts.js';
import { runsShellInSandbox, type ToolPolicy, type ToolSource } from '@otherbench/core/types/config.js';
import type { BrowserManager } from './browser/manager.js';
import { browserTool, pageFailure } from './browser/tool.js';
import { computerTool } from './computer-tool.js';
import { fsTools } from './fs-tools.js';
import { mediaAuditArgs, mediaTools, type MediaHost } from './media/tool.js';
import type { McpServerManager } from './mcp/manager.js';
import { SANDBOX_NETWORK_SPEC, SANDBOX_NETWORK_TOOL, sandboxRunCommandTool } from './sandbox-tool.js';
import { runCommandTool } from './shell-tool.js';
import { subagentTool } from './subagent-tool.js';
import { threadTools } from './thread-tools.js';
import { ApprovalRoundTrip } from './provider/approvals.js';
import { auditArgs, redact, RELAYED_TYPING_TOOL_NAME, writeAuditRow } from './provider/audit.js';
import { LIVE_TIMEOUT_MS, LiveArtifactCalls } from './provider/live.js';
import { deduplicateNames, mcpEntries } from './provider/mcp-tools.js';
import {
  cancelledAuth,
  deniedAuth,
  isScreenTool,
  messageOf,
  quoting,
  refusalResult,
  STOPPED_BEFORE_RUN_REASON,
  toolError,
  UNCHECKED_REASON,
  type Authorization,
  type CallDecision,
  type Denied,
  type Refused,
} from './provider/outcomes.js';

export { MCP_RESULT_MAX_CHARS } from './provider/mcp-tools.js';

export interface OtherBenchToolProviderOptions {
  /** Overridable id generator for audit row ids; defaults to `randomUUID`. */
  generateId?: () => string;
  /** Overridable clock, for deterministic duration assertions in tests. */
  now?: () => number;
  /** Where `run_command` runs for a profile whose shell runs in the sandbox (spec 2026-10-12-sandbox-design). Absent: such a run_command refuses. */
  sandbox?: Sandbox;
  /** How long a live call may take (spec 2026-10-12-live-artifacts); 30 s. Tests shorten it. */
  liveTimeoutMs?: number;
  /** The model's browser (spec 2026-10-12-model-browser-design). Without it, no profile gets the browser tool. */
  browser?: BrowserManager;
  /** The desktop shell's computer-use driver (spec 2026-10-12-computer-use-design); absent everywhere but the desktop app on Windows. */
  computer?: ComputerDriver;
  /** Where image and video generation finds its backends (server/src/media.ts). Without it, no profile gets the media tools. */
  media?: MediaHost;
}

const BUILTIN_FS_TOOLS: ToolSpec[] = fsTools;

/** A call `requestApproval` approved for something else to hand back for running (`runRelayedCall`). */
interface Approval {
  tool: string;
  source: ToolSource;
  chatId: string;
  messageId: string;
  profileId: string;
  grantedBy: string;
  decidedOnNode?: string;
}

/** A fresh plain object holding the model's own fields, so an approval can be tied to this object and no other. */
function plainObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/**
 * Assembles the tools one turn's `EngineRequest.tools` is populated with --
 * built-in fs/shell tools plus every allowlisted MCP server's currently
 * cached tools, namespaced `mcp__<server>__<tool>` -- and wraps every one of
 * them so a call must clear `PermissionBroker.decide()` before the
 * underlying tool's own `execute()` ever runs.
 *
 * The gate (see `gate()` below) is the load-bearing piece task 26 exists to
 * deliver: policy/grant/ask via the broker, an `approval-request` event plus
 * a suspended wait when the decision is `'ask'`, a denial mapped to a
 * structured tool-error result (never a thrown exception -- the model gets
 * something it can read and respond to, per decision #2), and an audit row
 * written for every outcome regardless of how it was authorised.
 *
 * A call reaches a tool by one of two paths, and both are made of the same
 * three private steps, so they cannot drift apart:
 *
 *   - `decideCall`: the reply not stopped; the call described (`describeCall`,
 *     and for computer use the profile's switch and "is anyone there" before
 *     that, so no native dialog comes up for a call that can't go ahead); the
 *     broker's decision on the DESCRIBED arguments; the card; the reply still
 *     not stopped. Its answer is approved-with-those-arguments, refused, or
 *     (Claude Code auto mode) deferred; in auto mode OtherBench's own tools
 *     are approved with no card instead.
 *   - `runApproved`: the reply still not stopped, then the tool's `execute`
 *     with the approved arguments and nothing else, and the audit row for
 *     what came of it.
 *   - `auditCall`: every audit row, with typed text redacted and nothing
 *     hidden in any string (`auditArgs`).
 *
 * An API model's path is `gate()`: decide, then run, in one closure. Claude
 * Code's path is `requestApproval()` (decide, when its PreToolUse hook asks)
 * and, later, the `execute` of the spec `relayOtherBenchTools` gave it, which is
 * `runRelayedCall`: it runs only an argument object `requestApproval` itself
 * approved, for the same chat, reply and profile, once. There is no bare
 * `execute` of the browser or the computer tool outside this class.
 *
 * `resolveApproval` is the other half of that suspension: called by the HTTP
 * route (routes/tools.ts) when a human answers a prompt, it wakes the exact
 * `awaitApproval` promise for that `requestId` (provider/approvals.ts) --
 * keyed by request id, never by `messageId` or chat id, which is what makes
 * concurrent compare-turn variants independent (decision #2's explicit
 * requirement): resolving one variant's request touches only that request's
 * waiter.
 *
 * `runLiveCall` (spec 2026-10-12-live-artifacts, provider/live.ts) is a
 * second entry point into the provider, not a second path: it asks
 * `broker.decide` exactly as `gate()` and `requestApproval()` do (with
 * `ctx.live` set, so the broker takes its live branch), audits every
 * decision, and only then calls the server, through the cache and the
 * per-artifact limits.
 */
export class OtherBenchToolProvider implements ToolProvider {
  /** The cards: raising them, waiting for an answer and handing it to the broker (provider/approvals.ts). */
  private readonly approvals: ApprovalRoundTrip;
  /**
   * The described arguments `requestApproval` approved for a spec that
   * describes its calls, by the argument object itself: what
   * `runRelayedCall` will run, once, and for whom. Held weakly: an approval
   * nobody comes back for goes with its arguments.
   */
  private readonly approved = new WeakMap<object, Approval>();
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly sandbox: Sandbox | null;
  private readonly asks: UserAsks;
  private readonly live: LiveArtifactCalls;
  private readonly browser: BrowserManager | null;
  private readonly computer: ComputerDriver | null;
  private readonly media: MediaHost | null;

  constructor(
    private readonly store: Store,
    private readonly broker: PermissionBroker,
    /** Only `listFor`/`refresh`/`shutdown` are used -- narrowed to these so a test can supply a minimal fake instead of a real `McpServerManager` with live connections. */
    private readonly mcp: Pick<McpServerManager, 'listFor' | 'refresh' | 'shutdown'>,
    options: OtherBenchToolProviderOptions = {}
  ) {
    this.generateId = options.generateId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.sandbox = options.sandbox ?? null;
    this.live = new LiveArtifactCalls({
      store,
      broker,
      mcp,
      now: this.now,
      timeoutMs: options.liveTimeoutMs ?? LIVE_TIMEOUT_MS,
      writeAudit: (ctx, toolName, args, result, durationMs, grantedBy, summaryOverride) => this.writeAudit(ctx, toolName, args, result, durationMs, grantedBy, summaryOverride),
    });
    // Also settles, as a denial, any card the broker's backstop drops.
    this.approvals = new ApprovalRoundTrip(broker);
    this.asks = new UserAsks((event) => this.approvals.notify(event));
    this.browser = options.browser ?? null;
    this.computer = options.computer ?? null;
    this.media = options.media ?? null;
  }

  onApprovalEvent(cb: (event: ToolApprovalEvent) => void): () => void {
    return this.approvals.onApprovalEvent(cb);
  }

  async listTools(policy: ToolPolicy): Promise<ToolSpec[]> {
    const raw: ToolSpec[] = [];
    // Filtered here (not just enforced later by the gate's decide() call) so
    // a model under a read-only fs policy is never even offered write_file/
    // edit_file only to have every call to them refused -- the policy
    // ceiling is applied at the earliest point it can be, not just at
    // call time. decide() still enforces the same ceiling independently
    // (defense in depth: nothing here relies on this filtering alone).
    if (policy.fs === 'readwrite') raw.push(...BUILTIN_FS_TOOLS);
    else if (policy.fs === 'read') raw.push(...BUILTIN_FS_TOOLS.filter((t) => t.risk === 'read'));
    // One run_command, never both: the sandboxed one when the shell runs there.
    if (policy.shell) raw.push(runsShellInSandbox(policy) ? this.sandboxTool(policy) : runCommandTool);
    // Artifacts (Deck #896): on unless the profile turns them off. A live
    // declaration may name only this profile's read-only MCP tools.
    if (policy.artifacts !== false) raw.push(artifactTool(this.store, () => liveToolRisks(this.relayMcpTools(policy.mcpServerIds))));
    // Recall (spec 2026-10-09-recall-design): on unless the profile turns it off.
    if (policy.recall !== false) raw.push(recallTool(this.store));
    // Thread tools (spec 2026-10-12-thread-cards-design): offered to every
    // profile; TurnRunner drops propose_plan when the chat's Plan mode is off,
    // and all three for a model that can't use tools.
    raw.push(...threadTools((ctx, input) => this.askUser(ctx, input)));
    // Sub-agents (spec 2026-10-12-api-subagents-design): off unless the profile turns them on.
    if (policy.subagents === true) raw.push(subagentTool(this.store, policy));
    // The model's browser (spec 2026-10-12-model-browser-design): off unless the profile turns it on.
    if (policy.browser === true && this.browser) raw.push(browserTool(this.browser, policy, (ctx, input) => this.askUser(ctx, input)));
    // Computer use (spec 2026-10-12-computer-use-design section 4): only when the
    // profile turns it on AND the desktop shell on this machine can carry it out.
    if (policy.computer === true && this.computer?.available()) raw.push(computerTool(this.computer, this.store));
    // Image and video generation (media-generation spec): each tool only when the
    // profile chose a backend for it. Claude Code gets them through `relayOtherBenchTools`.
    if (policy.media && this.media) raw.push(...(await mediaTools(this.media, policy, (ctx, input) => this.askUser(ctx, input), (ctx, p) => this.relayProgress(ctx, p))));
    raw.push(...this.mcpToolSpecs(policy.mcpServerIds));

    return deduplicateNames(raw).map((spec) => this.gate(spec, policy));
  }

  /**
   * Everything the Claude Code engine relays through its per-process OtherBench
   * server for this policy (the engine's gate approves each call with the
   * very same spec first): the allowlisted MCP servers' tools, the sandboxed
   * run_command when the shell runs in the sandbox and this OtherBench has one
   * (spec 2026-10-12-sandbox-design, "Claude Code"), and OtherBench's own relayed
   * tools (`relayOtherBenchTools`: the browser, computer use and image and video
   * generation, each of which runs only arguments `requestApproval` approved). Never the host run_command: a
   * profile that wants the sandbox gets it or nothing.
   */
  async relayTools(policy: ToolPolicy): Promise<ToolSpec[]> {
    const shell = runsShellInSandbox(policy) && this.sandbox !== null ? [this.sandboxTool(policy)] : [];
    return deduplicateNames([...shell, ...(await this.relayOtherBenchTools(policy)), ...this.relayMcpTools(policy.mcpServerIds)]);
  }

  /**
   * Only the allowlisted MCP servers' tools, ungated and deduplicated: what a
   * live artifact's declaration may name (spec 2026-10-12-live-artifacts),
   * and the MCP part of `relayTools`. Never the sandboxed run_command, the
   * browser or computer use. Never hand these to a model directly.
   */
  relayMcpTools(serverIds: string[]): ToolSpec[] {
    return serverIds.length === 0 ? [] : deduplicateNames(this.mcpToolSpecs(serverIds));
  }

  /**
   * OtherBench's own tools for the Claude Code relay: the browser, the computer
   * tool and generate_image / generate_video, each when the profile turns it on
   * (for computer use, when the desktop shell can carry it out too; for the
   * generators, when the profile chose a backend and there is a media host). The Claude Code gate approves each call
   * through `requestApproval`, which hands back the described arguments, and
   * the engine keeps them as an approval ticket.
   *
   * Unlike `relayMcpTools`, these are not bare specs: each one's `execute` is
   * `runRelayedCall`, which runs only an argument object `requestApproval`
   * approved, once, for the chat, reply and profile it approved it for, and
   * writes the audit row for what came of it. So whatever calls it, and with
   * whatever, nothing runs that no approval stands behind.
   */
  async relayOtherBenchTools(policy: ToolPolicy): Promise<ToolSpec[]> {
    const specs: ToolSpec[] = [];
    if (policy.browser === true && this.browser) specs.push(this.relayed(browserTool(this.browser, policy, (ctx, input) => this.askUser(ctx, input))));
    if (policy.computer === true && this.computer?.available()) specs.push(this.relayed(computerTool(this.computer, this.store)));
    // The generators have no describeCall of their own (an API model's gate needs none). This one
    // copies the model's arguments, which is what turns on the ticket and the identity check:
    // `runRelayedCall` runs only that object. The broker still decides on it (a card, or the
    // generation ask `execute` raises under confirmPrompts).
    if (policy.media && this.media) {
      for (const tool of await mediaTools(this.media, policy, (ctx, input) => this.askUser(ctx, input), (ctx, p) => this.relayProgress(ctx, p))) {
        specs.push(this.relayed({ ...tool, describeCall: async (args: unknown) => ({ args: plainObject(args), risk: 'execute' as const }) }));
      }
    }
    return specs;
  }

  private relayed(tool: ToolSpec): ToolSpec {
    return { ...tool, execute: (args: unknown, ctx: ToolContext): Promise<unknown> => this.runRelayedCall(tool, args, ctx) };
  }

  /** The sandboxed run_command for this policy; its network questions become sandbox_network cards. */
  private sandboxTool(policy: ToolPolicy): ToolSpec {
    return sandboxRunCommandTool(this.sandbox, policy, (host, port, ctx, signal) => this.approveNetwork(host, port, policy, ctx, signal));
  }

  /**
   * A sandboxed command wants a host that isn't on the allowlist: the broker
   * decides (a host grant, else a card; never automatic), and the outcome gets
   * its own audit row under sandbox_network. The card names the host in its
   * canonical spelling, so what a grant covers is what the card said. It is
   * taken down, and the answer is no, when the turn ends or the sandbox
   * withdraws the question (`askSignal`).
   */
  private async approveNetwork(host: string, port: number | undefined, policy: ToolPolicy, ctx: ToolContext, askSignal?: AbortSignal): Promise<boolean> {
    const startedAt = this.now();
    const canonical = canonicalHost(host);
    const asked: ToolContext = { ...ctx, signal: askSignal ? AbortSignal.any([ctx.signal, askSignal]) : ctx.signal };
    const args = canonical === null ? { host } : port === undefined ? { host: canonical } : { host: canonical, port };
    let auth: Authorization;
    if (canonical === null) {
      auth = { ok: false, code: 'permission_denied', reason: `The sandbox can't reach ${JSON.stringify(host)}: it isn't a valid host name.`, grantedBy: 'deny:policy' };
    } else if (asked.signal.aborted) {
      auth = cancelledAuth();
    } else {
      auth = await this.approvals.settle(this.broker.decide(SANDBOX_NETWORK_SPEC, args, policy, asked), asked, SANDBOX_NETWORK_SPEC);
    }
    if (auth.ok) {
      this.writeAudit(ctx, SANDBOX_NETWORK_TOOL, args, null, this.now() - startedAt, auth.grantedBy, `allowed ${canonical}${port === undefined ? '' : `:${port}`}`, auth.decidedOnNode);
    } else {
      this.writeAudit(ctx, SANDBOX_NETWORK_TOOL, args, toolError(auth.code, auth.reason), this.now() - startedAt, auth.grantedBy, undefined, auth.decidedOnNode);
    }
    return auth.ok;
  }

  async refreshMcp(serverId: string): Promise<void> {
    await this.mcp.refresh(serverId);
  }

  async shutdown(): Promise<void> {
    await this.mcp.shutdown();
  }

  /**
   * Wakes the suspended gate for a still-pending approval request. Returns
   * `false` (a no-op) for an unknown/already-resolved id rather than
   * throwing -- a stale double-submit from the UI, or a request that timed
   * out via the turn being cancelled, must not crash the caller.
   */
  resolveApproval(requestId: string, choice: ApprovalChoice, decidedOnNode?: string): boolean {
    return this.approvals.resolveApproval(requestId, choice, decidedOnNode);
  }

  private mcpToolSpecs(serverIds: string[]): ToolSpec[] {
    return mcpEntries(this.mcp, serverIds).map((e) => e.spec);
  }

  async requestApproval(tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext, opts: ApprovalOptions = {}): Promise<ApprovalOutcome> {
    const startedAt = this.now();
    const decided = await this.decideCall(tool, args, policy, ctx, opts);
    if (decided.kind === 'deferred') {
      this.auditCall(ctx, tool, decided.args, null, this.now() - startedAt, 'auto', 'delegated to Claude Code auto mode');
      return { deferred: true };
    }
    if (decided.kind === 'refused') {
      const { denied } = decided;
      this.auditCall(ctx, tool, decided.args, refusalResult(denied), this.now() - startedAt, denied.grantedBy, undefined, denied.decidedOnNode);
      // `about` goes with the reason: whoever hands it to a model puts it first (the Claude Code gate does).
      return { allowed: false, reason: denied.reason, ...(denied.about !== undefined ? { about: denied.about } : {}) };
    }
    this.auditCall(ctx, tool, decided.args, null, this.now() - startedAt, decided.grantedBy, 'delegated to Claude Code', decided.decidedOnNode);
    if (!tool.describeCall) return { allowed: true, grantedBy: decided.grantedBy };
    // What was approved is this one argument object, for this chat, reply and profile: `runRelayedCall` runs it and nothing else.
    if (typeof decided.args === 'object' && decided.args !== null) {
      this.approved.set(decided.args, {
        tool: tool.name,
        source: tool.source,
        chatId: ctx.chatId,
        messageId: ctx.messageId,
        profileId: ctx.profileId,
        grantedBy: decided.grantedBy,
        ...(decided.decidedOnNode ? { decidedOnNode: decided.decidedOnNode } : {}),
      });
    }
    return { allowed: true, grantedBy: decided.grantedBy, args: decided.args };
  }

  /** Questions and plans for the user (spec 2026-10-12-thread-cards-design): raised on the same event channel as approval cards. */
  askUser(ctx: ToolContext, input: AskInput): Promise<AskOutcome> {
    return this.asks.ask(ctx, input);
  }

  /** A generation call's progress, on the same event channel as cards. A call with no id has nothing to tie it to, so it gets none. */
  private relayProgress(ctx: ToolContext, progress: MediaProgress): void {
    if (ctx.toolCallId) this.approvals.notify({ type: 'progress', messageId: ctx.messageId, callId: ctx.toolCallId, progress });
  }

  answerAsk(askId: string, reply: AskReply): AskAnswerResult {
    return this.asks.answer(askId, reply);
  }

  recordAgentDenial(ctx: ToolContext, toolName: string, args: unknown, reason: string): void {
    // The classifier's own words, as one clean line: they are shown as this row's summary.
    const text = cardLine(reason, Number.POSITIVE_INFINITY) || 'Blocked by Claude Code auto mode.';
    // redact() truncates a long string exactly as it does audit args.
    // The relayed browser's and computer tool's arguments are kept as their own audit rows keep them (`auditArgs`).
    const typing = RELAYED_TYPING_TOOL_NAME.exec(toolName)?.[1];
    const audited = typing === 'browser' || typing === 'computer' ? auditArgs(typing, args) : args;
    this.writeAudit(ctx, toolName, audited, null, 0, 'deny:auto', redact(text) as string);
  }

  /** Each declared call's state for the viewer (provider/live.ts). */
  liveStatus(req: LiveStatusRequest): LiveCallStatus[] {
    return this.live.liveStatus(req);
  }

  /** The user allowed a live page's calls: grants every one that needs it, then the new states (provider/live.ts). */
  allowLive(req: LiveStatusRequest): LiveCallStatus[] {
    return this.live.allowLive(req);
  }

  revokeLive(chatId: string, artifactId: string): number {
    return this.live.revokeLive(chatId, artifactId);
  }

  /** Never throws: anything unexpected comes back as a `failed` outcome. */
  async runLiveCall(req: LiveRunRequest): Promise<LiveCallOutcome> {
    return this.live.runLiveCall(req);
  }

  /**
   * A call as the broker should see it (spec 2026-10-12-model-browser-design
   * §3): `describeCall`'s arguments and risk when the spec has one. A throw
   * is a refusal, never an unchecked call. Whatever the tool refuses with is
   * one clean line by the time it leaves here.
   */
  private async described(tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext): Promise<{ tool: ToolSpec; args: unknown } | Refused> {
    if (!tool.describeCall) return { tool, args };
    // Computer use that can't go ahead whatever the call is: refused here,
    // before the tool is asked anything, because its describeCall starts the
    // control session (the shell's native dialog). The broker refuses both
    // too, but it only decides after the call was described. A spec can
    // outlive the policy it was listed under (the Claude Code relay keeps its
    // specs for the life of a process), so being listed is not enough.
    // Plan mode is the same: the broker refuses a computer call while the
    // reply's plan waits (`allowedWhilePlanning`), and asking first here keeps
    // the start dialog from coming up for a call that will be refused anyway.
    if (tool.source === 'computer') {
      if (policy.computer !== true) return { refuse: COMPUTER_OFF_REASON };
      if (ctx.plan && !ctx.plan.approved && !allowedWhilePlanning(tool, args)) return { refuse: PLAN_REFUSAL, plan: true };
      if (isUnattendedRun(ctx)) return { refuse: COMPUTER_UNATTENDED_REASON, unattended: true };
    }
    try {
      const d = await tool.describeCall(args, ctx);
      if (!('refuse' in d)) return { tool: { ...tool, risk: d.risk }, args: d.args };
      return { refuse: cardLine(d.refuse, COMPUTER_LIMITS.resultTextLength) || 'This call was refused.', quoted: true };
    } catch (err) {
      return { refuse: `${UNCHECKED_REASON} ${messageOf(err)}`, quoted: true };
    }
  }

  /**
   * Everything that stands between a call and its tool, in the one order, for
   * every path (`gate()` for an API model, `requestApproval()` for Claude
   * Code). Nothing here runs the tool; nothing else decides whether it runs.
   *
   *   1. The reply is not stopped.
   *   2. The call is described (`described`): for computer use the profile's
   *      switch and "is anyone there" first, then the tool's `describeCall`,
   *      which throws away whatever the model put in the fields OtherBench fills
   *      in. A refusal, or a throw, ends the call with no card.
   *   3. The reply is still not stopped. Checked before a refusal is read: a
   *      `describeCall` that stopped because the reply did (the start dialog
   *      was up) was stopped, not refused by a rule, and is audited as that.
   *   4. The broker decides on the DESCRIBED arguments, and those are what a
   *      card shows, a grant is pinned to and the audit keeps.
   *   5. An 'ask' raises a card and waits (`settle`); for computer use an
   *      answer the broker refuses denies the call (`awaitApproval`).
   *   6. The reply is still not stopped, now that a person may have taken
   *      their time over the card.
   *
   * `args` of the answer are the described arguments once step 2 has them
   * (the only arguments an approved call may run with), the model's before.
   */
  private async decideCall(tool: ToolSpec, raw: unknown, policy: ToolPolicy, ctx: ToolContext, opts: ApprovalOptions = {}): Promise<CallDecision> {
    // A call that arrives after its turn ended must not run, even when a grant or policy would allow it.
    if (ctx.signal.aborted) return { kind: 'refused', args: raw, denied: cancelledAuth() };
    const call = await this.described(tool, raw, policy, ctx);
    if (ctx.signal.aborted) return { kind: 'refused', args: 'refuse' in call ? raw : call.args, denied: cancelledAuth() };
    if ('refuse' in call) {
      const denied = deniedAuth(call.refuse, call.unattended === true, call.plan === true);
      return { kind: 'refused', args: raw, denied: call.quoted === true ? quoting(tool, denied) : denied };
    }
    let decision: Decision;
    try {
      decision = this.broker.decide(call.tool, call.args, policy, ctx);
    } catch (err) {
      // As before for every other source: the failure is the caller's to see.
      if (!isScreenTool(tool.source)) throw err;
      // The browser and computer use fail closed, on the record: the call is refused and audited.
      console.error(`[OtherBenchToolProvider] the broker could not decide a "${tool.name}" call: ${messageOf(err)}`);
      return { kind: 'refused', args: call.args, denied: quoting(tool, deniedAuth(`${UNCHECKED_REASON} ${messageOf(err)}`, false)) };
    }
    // Never in a scheduled run, unless its schedule allows auto mode: nobody
    // is there, so the call is refused below rather than handed on.
    if (decision.kind === 'ask' && opts.deferAsk === true && (ctx.unattended !== true || ctx.unattendedAuto === true)) {
      // Auto mode: no card, no event and nothing stored -- the pending
      // request is dropped unanswered. A Claude Code tool goes to its
      // classifier. One of OtherBench's own (relayed, artifact, recall, plan)
      // is approved as it stands: a hand-off would leave it no ticket to run
      // with. Either way only an enabled tool gets here; a tool the profile
      // has off was denied above.
      this.broker.discard(decision.request.id);
      if (isDeferrableInAutoMode(call.tool, call.args)) return { kind: 'deferred', args: call.args };
      return { kind: 'approved', args: call.args, grantedBy: 'auto' };
    }
    const auth = await this.approvals.settle(decision, ctx, tool);
    if (!auth.ok) return { kind: 'refused', args: call.args, denied: auth };
    // The answer and a stop can come in the same step, the answer first: a stopped reply runs nothing all the same.
    if (ctx.signal.aborted) return { kind: 'refused', args: call.args, denied: cancelledAuth(STOPPED_BEFORE_RUN_REASON) };
    return { kind: 'approved', args: call.args, grantedBy: auth.grantedBy, ...(auth.decidedOnNode ? { decidedOnNode: auth.decidedOnNode } : {}) };
  }

  /**
   * Runs an approved call: the tool's `execute` with the approved (described)
   * arguments, never the model's own, and the audit row for what came of it.
   * The one place a gated tool is run, for both paths. The reply is checked
   * once more first: on Claude Code's path the call comes back to be run some
   * time after it was approved, and a reply stopped in between runs nothing
   * (audited as a stop).
   *
   * A browser or computer call that throws ends as an error result, cleaned
   * (and, for computer use, labelled) like any other, and is audited; every
   * other source's throw goes on to the caller as it always has.
   */
  private async runApproved(
    tool: ToolSpec,
    call: { args: unknown; grantedBy: string; decidedOnNode?: string },
    ctx: ToolContext,
    startedAt: number
  ): Promise<unknown> {
    if (ctx.signal.aborted) {
      const gone = cancelledAuth(STOPPED_BEFORE_RUN_REASON);
      const stopped = refusalResult(gone);
      this.auditCall(ctx, tool, call.args, stopped, this.now() - startedAt, gone.grantedBy, undefined, call.decidedOnNode);
      return stopped;
    }
    let result: unknown;
    try {
      result = await tool.execute(call.args, ctx);
    } catch (err) {
      if (!isScreenTool(tool.source)) throw err;
      // An engine error can quote the page: the browser's error carries the page's line, naming the site the call was approved for.
      const host = (call.args as { host?: unknown } | null)?.host;
      result = tool.source === 'computer' ? screenContentError('computer_failed', messageOf(err)) : pageFailure('browser_error', messageOf(err), typeof host === 'string' ? host : null);
    }
    // A generation's prompt can be edited in its card after approval: the row keeps the one that was sent.
    const audited = tool.source === 'media' ? mediaAuditArgs(call.args, result) : call.args;
    this.auditCall(ctx, tool, audited, result, this.now() - startedAt, call.grantedBy, undefined, call.decidedOnNode);
    return result;
  }

  /**
   * The `execute` of a spec handed to the Claude Code relay
   * (`relayOtherBenchTools`). It runs `args` only when they are the very argument
   * object `requestApproval` approved for this tool, and the call is for the
   * chat, the reply and the profile it approved them for; each approval runs
   * once. Anything else (the model's own arguments, arguments made to look
   * described, a copy, a second use, another chat's or another reply's
   * approval) runs nothing and is audited as a refusal by the rules.
   */
  private async runRelayedCall(tool: ToolSpec, args: unknown, ctx: ToolContext): Promise<unknown> {
    const startedAt = this.now();
    const approval = typeof args === 'object' && args !== null ? this.approved.get(args) : undefined;
    const stands =
      approval !== undefined &&
      approval.tool === tool.name &&
      approval.source === tool.source &&
      approval.chatId === ctx.chatId &&
      approval.messageId === ctx.messageId &&
      approval.profileId === ctx.profileId;
    if (!stands) {
      const denied: Denied = { ok: false, code: 'no_approval', reason: NO_APPROVAL_REASON, grantedBy: 'deny:policy' };
      const refused = refusalResult(denied);
      this.auditCall(ctx, tool, args, refused, this.now() - startedAt, denied.grantedBy);
      return refused;
    }
    this.approved.delete(args as object);
    return this.runApproved(tool, { args, grantedBy: approval.grantedBy, ...(approval.decidedOnNode ? { decidedOnNode: approval.decidedOnNode } : {}) }, ctx, startedAt);
  }

  /**
   * An API model's path to a tool: the spec `listTools` hands out. Its
   * `execute` decides the call (`decideCall`) and, only when it is approved,
   * runs it with the described arguments (`runApproved`); anything else is an
   * error result the model can read, audited.
   */
  private gate(tool: ToolSpec, policy: ToolPolicy): ToolSpec {
    return {
      ...tool,
      execute: async (args: unknown, ctx: ToolContext): Promise<unknown> => {
        const startedAt = this.now();
        const decided = await this.decideCall(tool, args, policy, ctx);
        if (decided.kind === 'approved') return this.runApproved(tool, decided, ctx, startedAt);
        // Only Claude Code's hook may hand a call to its classifier; a call that somehow came back deferred here does not run.
        const denied = decided.kind === 'refused' ? decided.denied : deniedAuth(`${UNCHECKED_REASON} it was left undecided.`, false);
        const result = refusalResult(denied);
        this.auditCall(ctx, tool, decided.args, result, this.now() - startedAt, denied.grantedBy, undefined, denied.decidedOnNode);
        return result;
      },
    };
  }

  /**
   * The audit row of a call to `tool`, on every path and for every outcome
   * (run, refused, denied, stopped, handed over). `args` are what the row is
   * about, as they are: `auditArgs` redacts what was typed and leaves nothing
   * hidden in a string, here and nowhere else, so no caller can forget to.
   */
  private auditCall(
    ctx: ToolContext,
    tool: ToolSpec,
    args: unknown,
    result: unknown,
    durationMs: number,
    grantedBy: string,
    summaryOverride?: string,
    decidedOnNode?: string
  ): void {
    this.writeAudit(ctx, tool.name, auditArgs(tool.source, args), result, durationMs, grantedBy, summaryOverride, decidedOnNode);
  }

  /** Writes one audit row (`writeAuditRow`, provider/audit.ts). `args` must already be what the audit may keep: only `auditCall` and `recordAgentDenial` call this. */
  private writeAudit(
    ctx: ToolContext,
    toolName: string,
    args: unknown,
    result: unknown,
    durationMs: number,
    grantedBy: string,
    summaryOverride?: string,
    decidedOnNode?: string
  ): void {
    writeAuditRow(this.store, this.generateId, ctx, toolName, args, result, durationMs, grantedBy, summaryOverride, decidedOnNode);
  }
}
