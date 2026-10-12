import { randomUUID } from 'node:crypto';
import { artifactTool, liveToolRisks } from './artifact-tool.js';
import { canonicalJson } from '@grunt/core/domain/live-artifacts.js';
import { recallTool } from './recall-tool.js';
import { isDeferrableInAutoMode, PermissionBroker, UNATTENDED_REASON, type Decision } from '@grunt/core/domain/permissions.js';
import { UserAsks } from '@grunt/core/domain/user-asks.js';
import type {
  ApprovalChoice,
  ApprovalOptions,
  ApprovalOutcome,
  AskAnswerResult,
  AskInput,
  AskOutcome,
  AskReply,
  LiveCallOutcome,
  LiveCallStatus,
  LiveRunRequest,
  LiveStatusRequest,
  RiskClass,
  ToolApprovalEvent,
  ToolContext,
  ToolProvider,
  ToolSpec,
} from '@grunt/core/ports/tool-provider.js';
import type { Sandbox } from '@grunt/core/ports/sandbox.js';
import type { Store } from '@grunt/core/ports/store.js';
import { canonicalHost } from '@grunt/core/domain/network-hosts.js';
import { runsShellInSandbox, type ToolPolicy } from '@grunt/core/types/config.js';
import { fsTools } from './fs-tools.js';
import { LiveCallCache, LiveCallLimiter, LiveRefusalAudit, shapeLiveResult } from './live-calls.js';
import type { McpCallResult, McpToolDescriptor } from './mcp/client.js';
import type { McpServerManager } from './mcp/manager.js';
import { SANDBOX_NETWORK_SPEC, SANDBOX_NETWORK_TOOL, sandboxRunCommandTool } from './sandbox-tool.js';
import { runCommandTool, toolError } from './shell-tool.js';
import { threadTools } from './thread-tools.js';

export interface GruntToolProviderOptions {
  /** Overridable id generator for audit row ids; defaults to `randomUUID`. */
  generateId?: () => string;
  /** Overridable clock, for deterministic duration assertions in tests. */
  now?: () => number;
  /** Where `run_command` runs for a profile whose shell runs in the sandbox (spec 2026-10-12-sandbox-design). Absent: such a run_command refuses. */
  sandbox?: Sandbox;
  /** How long a live call may take (spec 2026-10-12-live-artifacts); 30 s. Tests shorten it. */
  liveTimeoutMs?: number;
}

const LIVE_TIMEOUT_MS = 30_000;
/** The MCP SDK's error code for a request that timed out (ErrorCode.RequestTimeout). */
const MCP_REQUEST_TIMEOUT = -32001;

/** An MCP tool's spec with where it came from: the server and the tool's own (unsanitised) name. */
interface McpEntry {
  spec: ToolSpec;
  origin: { serverId: string; serverName: string; toolName: string };
}

/** `mcp__<server>__<tool>` as its two parts, for a name no server matches. */
function splitToolName(name: string): [string, string] {
  if (!name.startsWith('mcp__')) return [name, ''];
  const rest = name.slice('mcp__'.length);
  const at = rest.indexOf('__');
  return at === -1 ? [rest, ''] : [rest.slice(0, at), rest.slice(at + 2)];
}

const BUILTIN_FS_TOOLS: ToolSpec[] = fsTools;

type Authorization = (
  | { ok: true; grantedBy: string }
  | {
      ok: false;
      code: 'permission_denied' | 'approval_denied' | 'cancelled' | 'approval_dropped' | 'plan_mode' | 'approval_unavailable';
      reason: string;
      grantedBy: 'deny:policy' | 'deny:user' | 'deny:cancelled' | 'deny:plan' | 'deny:unattended';
    }
) & {
  /** The machine a person answered on, when it wasn't this one (v2 spec §3). */
  decidedOnNode?: string;
};

/** Why a pending approval ended: a person answered it, its turn ended, or the broker's backstop dropped it. */
type SettleCause = 'user' | 'turn-ended' | 'dropped';

const CANCELLED_REASON = 'The turn was stopped before this tool call was approved, so it did not run. Nobody denied it.';
const DROPPED_REASON = 'This approval request was dropped by the server (too many were pending), so the tool call did not run. Nobody denied it.';

function cancelledAuth(): Authorization {
  return { ok: false, code: 'cancelled', reason: CANCELLED_REASON, grantedBy: 'deny:cancelled' };
}

// ---------------------------------------------------------------------------
// Redaction / summarisation for the audit trail (task 26 decision #5): the
// audit row must record ENOUGH to reconstruct what happened, but never API
// keys, file contents, or full command/tool output.
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN = /content|body|password|secret|token|apikey|api_key|authorization|output|oldstring|newstring/i;
/** A failure's message for the page, cut to the length tool_error messages get. */
function boundMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

const MAX_STRING_PREVIEW = 200;
const MAX_REDACT_DEPTH = 6;

function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[omitted: too deeply nested]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_PREVIEW ? `${value.slice(0, MAX_STRING_PREVIEW)}… (${value.length} chars)` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function summarizeResult(result: unknown): string {
  if (result && typeof result === 'object' && (result as { error?: unknown }).error === true) {
    const code = (result as { code?: unknown }).code;
    return `error${typeof code === 'string' ? `: ${code}` : ''}`;
  }
  if (typeof result === 'string') return `ok (${result.length} chars)`;
  if (Array.isArray(result)) return `ok (${result.length} item${result.length === 1 ? '' : 's'})`;
  if (result && typeof result === 'object') {
    const fieldCount = Object.keys(result).length;
    return `ok (${fieldCount} field${fieldCount === 1 ? '' : 's'})`;
  }
  return 'ok';
}

function describeGrantedBy(decision: Extract<ReturnType<PermissionBroker['decide']>, { kind: 'allow' }>): string {
  return decision.grantId ? `${decision.grantedBy}:${decision.grantId}` : decision.grantedBy;
}

// ---------------------------------------------------------------------------
// MCP tool wrapping: namespacing + collision suffixing (decision #1) + risk
// classification from the server's own declared annotations.
// ---------------------------------------------------------------------------

function sanitizeNameSegment(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'x';
}

function mapMcpRisk(tool: McpToolDescriptor): RiskClass {
  if (tool.readOnlyHint === true) return 'read';
  if (tool.destructiveHint === true) return 'execute';
  return 'mutate'; // conservative default: an MCP tool that declares nothing is treated as capable of mutating something.
}

function summarizeMcpContent(content: unknown): string {
  if (Array.isArray(content)) {
    const withText = content.find(
      (c): c is { text: string } => !!c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
    );
    if (withText) return withText.text.slice(0, 500);
  }
  return 'The MCP tool call reported an error.';
}

// ---------------------------------------------------------------------------

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
 * `resolveApproval` is the other half of that suspension: called by the HTTP
 * route (routes/tools.ts) when a human answers a prompt, it wakes the exact
 * `awaitApproval` promise for that `requestId` -- keyed by request id, never
 * by `messageId` or chat id, which is what makes concurrent compare-turn
 * variants independent (decision #2's explicit requirement): resolving one
 * variant's request touches only that request's waiter.
 *
 * `runLiveCall` (spec 2026-10-12-live-artifacts) is a second entry point
 * into this file, not a second path: it asks `broker.decide` exactly as
 * `gate()` and `requestApproval()` do (with `ctx.live` set, so the broker
 * takes its live branch), audits every decision, and only then calls the
 * server, through the cache and the per-artifact limits.
 */
export class GruntToolProvider implements ToolProvider {
  private readonly listeners = new Set<(event: ToolApprovalEvent) => void>();
  /** requestId -> settle(choice, alreadyDroppedByBroker). One entry per card awaiting an answer; removed when it settles. */
  private readonly waiters = new Map<string, (choice: ApprovalChoice, cause: SettleCause, decidedOnNode?: string) => void>();
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly sandbox: Sandbox | null;
  private readonly asks: UserAsks;
  private readonly liveTimeoutMs: number;
  private readonly liveCache: LiveCallCache;
  private readonly liveLimiter: LiveCallLimiter;
  private readonly liveRefusals: LiveRefusalAudit;

  constructor(
    private readonly store: Store,
    private readonly broker: PermissionBroker,
    /** Only `listFor`/`refresh`/`shutdown` are used -- narrowed to these so a test can supply a minimal fake instead of a real `McpServerManager` with live connections. */
    private readonly mcp: Pick<McpServerManager, 'listFor' | 'refresh' | 'shutdown'>,
    options: GruntToolProviderOptions = {}
  ) {
    this.generateId = options.generateId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.sandbox = options.sandbox ?? null;
    this.liveTimeoutMs = options.liveTimeoutMs ?? LIVE_TIMEOUT_MS;
    this.liveCache = new LiveCallCache(this.now);
    this.liveLimiter = new LiveCallLimiter(this.now);
    this.liveRefusals = new LiveRefusalAudit(this.now);
    this.asks = new UserAsks((event) => this.notify(event));
    // The broker's backstop dropped a request nobody ended. Its waiter must
    // not hang (or, worse, later be approved with the broker no longer
    // knowing it): settle it as a denial, which also emits `resolved` so the
    // UI drops the card.
    this.broker.onEvict((requestId) => this.waiters.get(requestId)?.({ choice: 'deny' }, 'dropped'));
  }

  onApprovalEvent(cb: (event: ToolApprovalEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
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
    raw.push(...this.mcpToolSpecs(policy.mcpServerIds));

    return this.deduplicateNames(raw).map((spec) => this.gate(spec, policy));
  }

  /**
   * Everything the Claude Code engine relays through its per-process Grunt
   * server for this policy, ungated (the engine's gate approves each call
   * with the very same spec first): the allowlisted MCP servers' tools, and
   * the sandboxed run_command when the shell runs in the sandbox and this
   * Grunt has one (spec 2026-10-12-sandbox-design, "Claude Code"). Never the
   * host run_command: a profile that wants the sandbox gets it or nothing.
   */
  relayTools(policy: ToolPolicy): ToolSpec[] {
    const shell = runsShellInSandbox(policy) && this.sandbox !== null ? [this.sandboxTool(policy)] : [];
    return this.deduplicateNames([...shell, ...this.relayMcpTools(policy.mcpServerIds)]);
  }

  /**
   * Only the allowlisted MCP servers' tools, ungated and deduplicated: what a
   * live artifact's declaration may name (spec 2026-10-12-live-artifacts),
   * and the MCP part of `relayTools`. Never the sandboxed run_command.
   */
  relayMcpTools(serverIds: string[]): ToolSpec[] {
    return serverIds.length === 0 ? [] : this.deduplicateNames(this.mcpToolSpecs(serverIds));
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
      auth = await this.authorize(SANDBOX_NETWORK_SPEC, args, policy, asked);
    }
    if (auth.ok) {
      this.audit(ctx, SANDBOX_NETWORK_TOOL, args, null, this.now() - startedAt, auth.grantedBy, `allowed ${canonical}${port === undefined ? '' : `:${port}`}`, auth.decidedOnNode);
    } else {
      this.audit(ctx, SANDBOX_NETWORK_TOOL, args, toolError(auth.code, auth.reason), this.now() - startedAt, auth.grantedBy, undefined, auth.decidedOnNode);
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
    const settle = this.waiters.get(requestId);
    if (!settle) return false;
    settle(choice, 'user', decidedOnNode);
    return true;
  }

  private mcpToolSpecs(serverIds: string[]): ToolSpec[] {
    return this.mcpEntries(serverIds).map((e) => e.spec);
  }

  /** Each MCP tool's spec with its origin, so a live call can reach the server under the tool's own name. */
  private mcpEntries(serverIds: string[]): McpEntry[] {
    const entries: McpEntry[] = [];
    for (const { id, name, client } of this.mcp.listFor(serverIds)) {
      for (const tool of client.tools) {
        const namespacedName = `mcp__${sanitizeNameSegment(name)}__${sanitizeNameSegment(tool.name)}`;
        entries.push({
          origin: { serverId: id, serverName: name, toolName: tool.name },
          spec: {
            name: namespacedName,
            description: tool.description,
            parameters: tool.inputSchema,
            risk: mapMcpRisk(tool),
            source: 'mcp',
            // The SERVER id, not the display name: `PermissionBroker` checks
            // this against `ToolPolicy.mcpServerIds` so a tool from a server
            // this profile never enabled is denied rather than riding on the
            // fact that some other server is enabled.
            serverId: id,
            // Looks the server's client up again at call time rather than
            // using the one it was listed with: turning a server off and on
            // replaces its client, and the Claude Code relay keeps these specs
            // for the life of a process, which can span that.
            execute: async (args: unknown) => {
              const live = this.mcp.listFor([id])[0]?.client;
              if (!live) return toolError('mcp_call_failed', `MCP server "${name}" isn't connected.`);
              try {
                const result = await live.callTool(tool.name, args);
                if (result.isError) return toolError('mcp_tool_error', summarizeMcpContent(result.content));
                return result.content;
              } catch (err) {
                return toolError('mcp_call_failed', err instanceof Error ? err.message : String(err));
              }
            },
          },
        });
      }
    }
    return entries;
  }

  /**
   * The profile's MCP tool called `name` (as listTools names it), with its
   * origin; null when it has none, or `{ reason }` when the name could mean
   * more than one tool. `mcp_server.name` isn't unique, sanitising collapses
   * distinct names, and the `_2` suffix follows listing order, which moves as
   * servers connect and drop. A grant is keyed on the name, so honouring an
   * ambiguous one could run another server's tool under it. (It is keyed on
   * the server's id too, so a server renamed or replaced into a granted name
   * needs its own OK.)
   */
  private liveTarget(policy: ToolPolicy, name: string): { entry: McpEntry } | { reason: string } | null {
    if (policy.mcpServerIds.length === 0) return null;
    const entries = this.mcpEntries(policy.mcpServerIds);
    // Deduplicated as listTools does, so a suffixed name means the same tool here.
    const specs = this.deduplicateNames(entries.map((e) => e.spec), false);
    const at = specs.findIndex((s) => s.name === name);
    if (at === -1) return null;
    const entry: McpEntry = { spec: specs[at]!, origin: entries[at]!.origin };
    const baseName = entries[at]!.spec.name;
    const serverSegment = sanitizeNameSegment(entry.origin.serverName);
    const ambiguous =
      specs.filter((s) => s.name === name).length > 1 ||
      entries.filter((e) => e.spec.name === baseName).length > 1 ||
      // Another enabled server of this profile that shares the name but isn't connected right now: its tool may come back under this one.
      this.store.mcpServers
        .list()
        .some((r) => r.enabled && r.id !== entry.origin.serverId && policy.mcpServerIds.includes(r.id) && sanitizeNameSegment(r.name) === serverSegment);
    if (ambiguous) return { reason: `"${name}" names more than one tool; rename one of the MCP servers so each has its own name.` };
    return { entry };
  }

  /** Why the profile has no tool called `name`, in words the viewer shows. */
  private whyUnavailable(policy: ToolPolicy, name: string): string {
    const rows = this.store.mcpServers.list().filter((r) => name.startsWith(`mcp__${sanitizeNameSegment(r.name)}__`));
    if (rows.length === 0) return `MCP server "${splitToolName(name)[0]}" isn't set up on this machine.`;
    const enabled = rows.filter((r) => r.enabled);
    if (enabled.length === 0) return `MCP server "${rows[0]!.name}" is turned off.`;
    const inProfile = enabled.filter((r) => policy.mcpServerIds.includes(r.id));
    if (inProfile.length === 0) return `MCP server "${enabled[0]!.name}" isn't turned on for this chat's profile.`;
    const connected = this.mcp.listFor(inProfile.map((r) => r.id));
    if (connected.length === 0) return `MCP server "${inProfile[0]!.name}" isn't connected.`;
    const server = connected[0]!.name;
    return `MCP server "${server}" has no tool "${name.slice(`mcp__${sanitizeNameSegment(server)}__`.length)}".`;
  }

  /**
   * A model must never be handed two distinct tools under one name (decision
   * #1). The `mcp__<server>__<tool>` namespace already prevents same-named
   * tools on different servers from colliding; this closes the residual
   * case where sanitization or a builtin name still produces a duplicate --
   * later entries (stable insertion order: fs, then shell, then each MCP
   * server in policy order, each server's own tools in `tools/list` order)
   * are suffixed `_2`, `_3`, ... deterministically, and the collision is
   * logged so it's diagnosable rather than silently masking one tool.
   */
  private deduplicateNames(specs: ToolSpec[], log = true): ToolSpec[] {
    const seen = new Map<string, number>();
    return specs.map((spec) => {
      const priorCount = seen.get(spec.name) ?? 0;
      seen.set(spec.name, priorCount + 1);
      if (priorCount === 0) return spec;
      const suffixed = `${spec.name}_${priorCount + 1}`;
      if (log) console.warn(`[GruntToolProvider] tool name collision on "${spec.name}"; suffixed to "${suffixed}".`);
      return { ...spec, name: suffixed };
    });
  }

  async requestApproval(tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext, opts: ApprovalOptions = {}): Promise<ApprovalOutcome> {
    const startedAt = this.now();
    if (ctx.signal.aborted) {
      const gone = cancelledAuth();
      if (!gone.ok) {
        this.audit(ctx, tool.name, args, toolError(gone.code, gone.reason), 0, gone.grantedBy);
        return { allowed: false, reason: gone.reason };
      }
    }
    const decision = this.broker.decide(tool, args, policy, ctx);
    if (decision.kind === 'ask' && opts.deferAsk === true && ctx.unattended !== true && isDeferrableInAutoMode(tool, args)) {
      // Auto mode: Claude Code's classifier decides this call. No card, no
      // event and nothing stored -- the pending request is dropped unanswered.
      this.broker.discard(decision.request.id);
      this.audit(ctx, tool.name, args, null, this.now() - startedAt, 'auto', 'delegated to Claude Code auto mode');
      return { deferred: true };
    }
    const auth = await this.settle(decision, ctx);
    if (!auth.ok) {
      this.audit(ctx, tool.name, args, toolError(auth.code, auth.reason), this.now() - startedAt, auth.grantedBy, undefined, auth.decidedOnNode);
      return { allowed: false, reason: auth.reason };
    }
    this.audit(ctx, tool.name, args, null, this.now() - startedAt, auth.grantedBy, 'delegated to Claude Code', auth.decidedOnNode);
    return { allowed: true, grantedBy: auth.grantedBy };
  }

  /** Questions and plans for the user (spec 2026-10-12-thread-cards-design): raised on the same event channel as approval cards. */
  askUser(ctx: ToolContext, input: AskInput): Promise<AskOutcome> {
    return this.asks.ask(ctx, input);
  }

  answerAsk(askId: string, reply: AskReply): AskAnswerResult {
    return this.asks.answer(askId, reply);
  }

  recordAgentDenial(ctx: ToolContext, toolName: string, args: unknown, reason: string): void {
    const text = reason.trim().length > 0 ? reason.trim() : 'Blocked by Claude Code auto mode.';
    // redact() truncates a long string exactly as it does audit args.
    this.audit(ctx, toolName, args, null, 0, 'deny:auto', redact(text) as string);
  }

  liveStatus(req: LiveStatusRequest): LiveCallStatus[] {
    return req.calls.map(({ call, hash }): LiveCallStatus => {
      const found = this.liveTarget(req.policy, call.tool);
      if (!found || 'reason' in found) {
        const [serverName, toolName] = splitToolName(call.tool);
        return { callId: call.id, tool: call.tool, serverName, toolName, description: '', state: 'unavailable', reason: found ? found.reason : this.whyUnavailable(req.policy, call.tool) };
      }
      const target = found.entry;
      const base = { callId: call.id, tool: call.tool, serverName: target.origin.serverName, toolName: target.origin.toolName, description: target.spec.description.slice(0, 300) };
      const why = this.broker.liveIneligibility(target.spec, req.policy);
      if (why) return { ...base, state: 'unavailable', reason: why };
      // Against the tool's current server: a grant made under a server since renamed or replaced doesn't count.
      const live = { artifactId: req.artifactId, callId: call.id, hash, serverId: target.origin.serverId };
      const granted = this.broker.liveGrant(target.spec, { chatId: req.chatId, profileId: req.profileId, live });
      return { ...base, state: granted ? 'allowed' : 'needs_ok' };
    });
  }

  allowLive(req: LiveStatusRequest): LiveCallStatus[] {
    const before = this.liveStatus(req);
    const calls = req.calls.flatMap(({ call, hash }, i) => {
      if (before[i]!.state !== 'needs_ok') return [];
      const found = this.liveTarget(req.policy, call.tool);
      return found && 'entry' in found ? [{ tool: found.entry.spec, callId: call.id, hash, serverId: found.entry.origin.serverId }] : [];
    });
    if (calls.length > 0) this.broker.grantLive({ chatId: req.chatId, profileId: req.profileId, artifactId: req.artifactId, policy: req.policy, calls });
    return this.liveStatus(req);
  }

  revokeLive(chatId: string, artifactId: string): number {
    return this.broker.revokeLive(chatId, artifactId);
  }

  /** Never throws: anything unexpected comes back as a `failed` outcome. */
  async runLiveCall(req: LiveRunRequest): Promise<LiveCallOutcome> {
    try {
      return await this.runLive(req);
    } catch (err) {
      return { ok: false, code: 'failed', message: boundMessage(err) };
    }
  }

  private async runLive(req: LiveRunRequest): Promise<LiveCallOutcome> {
    const startedAt = this.now();
    const found = this.liveTarget(req.policy, req.toolName);
    if (!found) return { ok: false, code: 'not_available', message: this.whyUnavailable(req.policy, req.toolName) };
    if ('reason' in found) return { ok: false, code: 'not_available', message: found.reason };
    const target = found.entry;
    const ctx: ToolContext = {
      chatId: req.chatId,
      messageId: req.messageId,
      profileId: req.profileId,
      workspaceRoot: null,
      signal: req.signal,
      // The server id comes from the lookup above, never from the request.
      live: { artifactId: req.artifactId, callId: req.callId, hash: req.hash, serverId: target.origin.serverId },
    };
    const decision = this.broker.decide(target.spec, req.args, req.policy, ctx);
    if (decision.kind !== 'allow') {
      // The live branch never asks; should it ever, drop the request rather than leave a card nobody can see.
      if (decision.kind === 'ask') this.broker.discard(decision.request.id);
      const message = decision.kind === 'deny' ? decision.reason : 'A live call was asked about, which never happens; it did not run.';
      const code = decision.kind === 'deny' && decision.code === 'not_approved' ? 'not_approved' : 'refused';
      this.auditLive(this.liveRefusals.take(req.artifactId), ctx, target.spec.name, req.args, toolError(code, message), this.now() - startedAt, 'deny:policy');
      return { ok: false, code, message };
    }
    const grantedBy = `live:${decision.grantId ?? ''}`;
    // The server is part of the key; canonical args last, so the fields before them can't be confused with them.
    const key = [req.chatId, req.profileId, req.artifactId, req.callId, req.hash, target.origin.serverId, canonicalJson(req.args)].join('|');
    if (!req.fresh) {
      const hit = this.liveCache.get(key);
      // A copy: the cache hands back the stored object itself.
      if (hit) return { ok: true, ...hit, cached: true };
    }
    if (!this.liveLimiter.tryStart(req.artifactId)) {
      const message = 'This page asked for live data too often. Wait a minute, then refresh it.';
      const unaudited = this.liveRefusals.rateLimited(req.artifactId);
      if (unaudited !== null) this.auditLive(unaudited, ctx, target.spec.name, req.args, toolError('rate_limited', message), this.now() - startedAt, grantedBy);
      return { ok: false, code: 'rate_limited', message };
    }
    try {
      const outcome = await this.callLive(target, req);
      const audited = outcome.ok ? outcome : toolError(outcome.code, outcome.message);
      this.auditLive(this.liveRefusals.take(req.artifactId), ctx, target.spec.name, req.args, audited, this.now() - startedAt, grantedBy);
      if (outcome.ok) {
        const { ok: _ok, cached: _cached, ...result } = outcome;
        this.liveCache.set(key, result);
      }
      return outcome;
    } finally {
      this.liveLimiter.finish(req.artifactId);
    }
  }

  /** A live call's audit row, noting the artifact's rate_limited refusals that weren't given one of their own. */
  private auditLive(unaudited: number, ctx: ToolContext, toolName: string, args: unknown, result: unknown, durationMs: number, grantedBy: string): void {
    const note = unaudited > 0 ? ` (+${unaudited} rate_limited call${unaudited === 1 ? '' : 's'} not audited)` : '';
    this.audit(ctx, toolName, args, result, durationMs, grantedBy, `${summarizeResult(result)}${note}`);
  }

  /** Calls the server for an allowed live call, within the timeout, and shapes its result for the page. */
  private async callLive(target: McpEntry, req: LiveRunRequest): Promise<LiveCallOutcome> {
    const client = this.mcp.listFor([target.origin.serverId])[0]?.client;
    if (!client) return { ok: false, code: 'not_available', message: `MCP server "${target.origin.serverName}" isn't connected.` };
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(this.liveTimeoutMs)]);
    let result: McpCallResult;
    try {
      result = await client.callTool(target.origin.toolName, req.args, { signal, timeoutMs: this.liveTimeoutMs });
    } catch (err) {
      const timedOut = !req.signal.aborted && (signal.aborted || (err as { code?: unknown }).code === MCP_REQUEST_TIMEOUT);
      if (timedOut) return { ok: false, code: 'timeout', message: `"${target.origin.toolName}" didn't answer within ${Math.round(this.liveTimeoutMs / 1000)} seconds.` };
      return { ok: false, code: 'failed', message: boundMessage(err) };
    }
    if (result.isError) return { ok: false, code: 'tool_error', message: summarizeMcpContent(result.content) };
    const shaped = shapeLiveResult(result.content, result.structured);
    if (!shaped.ok) return shaped;
    return { ...shaped, cached: false, at: this.now() };
  }

  private authorize(tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext): Promise<Authorization> {
    return this.settle(this.broker.decide(tool, args, policy, ctx), ctx);
  }

  /** Turns a broker decision into an authorisation, raising (and waiting on) an approval card for 'ask'. */
  private async settle(decision: Decision, ctx: ToolContext): Promise<Authorization> {
    if (decision.kind === 'deny') {
      return decision.plan
        ? { ok: false, code: 'plan_mode', reason: decision.reason, grantedBy: 'deny:plan' }
        : { ok: false, code: 'permission_denied', reason: decision.reason, grantedBy: 'deny:policy' };
    }
    if (decision.kind === 'allow') return { ok: true, grantedBy: describeGrantedBy(decision) };

    const { request } = decision;
    // The turn already ended: nobody is there to answer and an abort listener
    // added now would never fire. Drop the request, raise no card.
    if (ctx.signal.aborted) {
      this.broker.discard(request.id);
      return cancelledAuth();
    }
    // A scheduled run (spec 2026-10-12-scheduled-tasks-design §2): nobody can
    // answer a card, so the request is dropped unanswered -- no waiter, no
    // event -- and the call is refused with a reason the model can act on.
    // Every card path comes through here (gated tools, Claude Code's gate,
    // the sandbox's network ask), so this one check covers them all.
    if (ctx.unattended === true) {
      this.broker.discard(request.id);
      return { ok: false, code: 'approval_unavailable', reason: UNATTENDED_REASON, grantedBy: 'deny:unattended' };
    }
    // Register the waiter BEFORE notifying so a listener that answers
    // synchronously from inside the 'request' event still reaches it.
    const pending = this.awaitApproval(request.id, ctx.signal);
    this.notify({ type: 'request', request });
    const { choice, cause, decidedOnNode } = await pending;
    this.notify({ type: 'resolved', requestId: request.id, messageId: request.messageId, choice: choice.choice });
    const on = decidedOnNode ? { decidedOnNode } : {};
    if (cause === 'turn-ended') return cancelledAuth();
    if (cause === 'dropped') return { ok: false, code: 'approval_dropped', reason: DROPPED_REASON, grantedBy: 'deny:cancelled', ...on };
    if (choice.choice === 'deny') return { ok: false, code: 'approval_denied', reason: 'The user denied this tool call.', grantedBy: 'deny:user', ...on };
    return { ok: true, grantedBy: `ask:${choice.choice}`, ...on };
  }

  private gate(tool: ToolSpec, policy: ToolPolicy): ToolSpec {
    return {
      ...tool,
      execute: async (args: unknown, ctx: ToolContext): Promise<unknown> => {
        const startedAt = this.now();
        // A call that arrives after its turn ended must not run, even when a
        // grant or policy would allow it.
        const auth = ctx.signal.aborted ? cancelledAuth() : await this.authorize(tool, args, policy, ctx);
        if (!auth.ok) {
          const result = toolError(auth.code, auth.reason);
          this.audit(ctx, tool.name, args, result, this.now() - startedAt, auth.grantedBy, undefined, auth.decidedOnNode);
          return result;
        }
        const result = await tool.execute(args, ctx);
        this.audit(ctx, tool.name, args, result, this.now() - startedAt, auth.grantedBy, undefined, auth.decidedOnNode);
        return result;
      },
    };
  }

  private notify(event: ToolApprovalEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch (err) {
        console.error('[GruntToolProvider] an approval listener threw:', err);
      }
    }
  }

  /**
   * Suspends until `resolveApproval(requestId, ...)` is called, or
   * `signal` aborts (the turn/variant was cancelled) -- whichever comes
   * first. `PermissionBroker.resolve()` is called EXACTLY once, from
   * `settle`, regardless of which path triggered it -- a `done` guard stops
   * a same-tick race between a real answer and an abort from calling it
   * twice (the broker throws on a duplicate resolve of the same request
   * id). An abort is treated as an implicit denial: 'deny' persists no
   * grant, so this is always safe to do without asking anyone.
   */
  private awaitApproval(requestId: string, signal: AbortSignal): Promise<{ choice: ApprovalChoice; cause: SettleCause; decidedOnNode?: string }> {
    return new Promise((resolve) => {
      let done = false;
      const settle = (choice: ApprovalChoice, cause: SettleCause, decidedOnNode?: string): void => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(requestId);
        let final = choice;
        if (cause === 'dropped' || !this.broker.hasPending(requestId)) {
          // The broker no longer knows this request, so it can neither record
          // a grant nor vouch for the call. Fail closed.
          final = { choice: 'deny' };
        } else {
          try {
            this.broker.resolve(requestId, choice);
          } catch (err) {
            console.error(`[GruntToolProvider] broker.resolve("${requestId}") failed:`, err);
          }
        }
        resolve({
          choice: final,
          cause: cause === 'user' && final.choice === 'deny' && choice.choice !== 'deny' ? 'dropped' : cause,
          ...(decidedOnNode ? { decidedOnNode } : {}),
        });
      };
      const onAbort = (): void => settle({ choice: 'deny' }, 'turn-ended');
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(requestId, settle);
    });
  }

  private audit(
    ctx: ToolContext,
    toolName: string,
    args: unknown,
    result: unknown,
    durationMs: number,
    grantedBy: string,
    summaryOverride?: string,
    decidedOnNode?: string
  ): void {
    try {
      this.store.audit.create({
        id: this.generateId(),
        chatId: ctx.chatId,
        messageId: ctx.messageId,
        toolName,
        argsRedacted: redact(args),
        resultSummary: summaryOverride ?? summarizeResult(result),
        durationMs,
        grantedBy,
        ...(decidedOnNode ? { decidedOnNode } : {}),
      });
    } catch (err) {
      console.error(`[GruntToolProvider] failed to write an audit row for "${toolName}":`, err);
    }
  }
}
