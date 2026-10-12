import { randomUUID } from 'node:crypto';
import { artifactTool } from './artifact-tool.js';
import { recallTool } from './recall-tool.js';
import { isDeferrableInAutoMode, PermissionBroker, type Decision } from '@grunt/core/domain/permissions.js';
import { UserAsks } from '@grunt/core/domain/user-asks.js';
import type {
  ApprovalChoice,
  ApprovalOptions,
  ApprovalOutcome,
  AskAnswerResult,
  AskInput,
  AskOutcome,
  AskReply,
  RiskClass,
  ToolApprovalEvent,
  ToolContext,
  ToolProvider,
  ToolSpec,
} from '@grunt/core/ports/tool-provider.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';
import { fsTools } from './fs-tools.js';
import type { McpToolDescriptor } from './mcp/client.js';
import type { McpServerManager } from './mcp/manager.js';
import { runCommandTool } from './shell-tool.js';

export interface GruntToolProviderOptions {
  /** Overridable id generator for audit row ids; defaults to `randomUUID`. */
  generateId?: () => string;
  /** Overridable clock, for deterministic duration assertions in tests. */
  now?: () => number;
}

const BUILTIN_FS_TOOLS: ToolSpec[] = fsTools;
const BUILTIN_SHELL_TOOLS: ToolSpec[] = [runCommandTool];

interface ToolError {
  error: true;
  code: string;
  message: string;
}

type Authorization = (
  | { ok: true; grantedBy: string }
  | {
      ok: false;
      code: 'permission_denied' | 'approval_denied' | 'cancelled' | 'approval_dropped' | 'plan_mode';
      reason: string;
      grantedBy: 'deny:policy' | 'deny:user' | 'deny:cancelled' | 'deny:plan';
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

function toolError(code: string, message: string): ToolError {
  return { error: true, code, message };
}

// ---------------------------------------------------------------------------
// Redaction / summarisation for the audit trail (task 26 decision #5): the
// audit row must record ENOUGH to reconstruct what happened, but never API
// keys, file contents, or full command/tool output.
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN = /content|body|password|secret|token|apikey|api_key|authorization|output|oldstring|newstring/i;
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
 */
export class GruntToolProvider implements ToolProvider {
  private readonly listeners = new Set<(event: ToolApprovalEvent) => void>();
  /** requestId -> settle(choice, alreadyDroppedByBroker). One entry per card awaiting an answer; removed when it settles. */
  private readonly waiters = new Map<string, (choice: ApprovalChoice, cause: SettleCause, decidedOnNode?: string) => void>();
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly asks: UserAsks;

  constructor(
    private readonly store: Store,
    private readonly broker: PermissionBroker,
    /** Only `listFor`/`refresh`/`shutdown` are used -- narrowed to these so a test can supply a minimal fake instead of a real `McpServerManager` with live connections. */
    private readonly mcp: Pick<McpServerManager, 'listFor' | 'refresh' | 'shutdown'>,
    options: GruntToolProviderOptions = {}
  ) {
    this.generateId = options.generateId ?? randomUUID;
    this.now = options.now ?? Date.now;
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
    if (policy.shell) raw.push(...BUILTIN_SHELL_TOOLS);
    // Artifacts (Deck #896): on unless the profile turns them off.
    if (policy.artifacts !== false) raw.push(artifactTool(this.store));
    // Recall (spec 2026-10-09-recall-design): on unless the profile turns it off.
    if (policy.recall !== false) raw.push(recallTool(this.store));
    raw.push(...this.mcpToolSpecs(policy.mcpServerIds));

    return this.deduplicateNames(raw).map((spec) => this.gate(spec, policy));
  }

  /**
   * The given MCP servers' tools as `listTools` names and describes them,
   * but UNGATED: for the Claude Code relay only (spec
   * 2026-10-11-claude-code-clean-chat-and-mcp-design §2), whose gate approves
   * each call through `requestApproval` with the very same spec before it
   * calls `execute`. Never hand these to a model directly.
   */
  relayMcpTools(serverIds: string[]): ToolSpec[] {
    return serverIds.length === 0 ? [] : this.deduplicateNames(this.mcpToolSpecs(serverIds));
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
    const specs: ToolSpec[] = [];
    for (const { id, name, client } of this.mcp.listFor(serverIds)) {
      for (const tool of client.tools) {
        const namespacedName = `mcp__${sanitizeNameSegment(name)}__${sanitizeNameSegment(tool.name)}`;
        specs.push({
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
        });
      }
    }
    return specs;
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
  private deduplicateNames(specs: ToolSpec[]): ToolSpec[] {
    const seen = new Map<string, number>();
    return specs.map((spec) => {
      const priorCount = seen.get(spec.name) ?? 0;
      seen.set(spec.name, priorCount + 1);
      if (priorCount === 0) return spec;
      const suffixed = `${spec.name}_${priorCount + 1}`;
      console.warn(`[GruntToolProvider] tool name collision on "${spec.name}"; suffixed to "${suffixed}".`);
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
    if (decision.kind === 'ask' && opts.deferAsk === true && isDeferrableInAutoMode(tool, args)) {
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
