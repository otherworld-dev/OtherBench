import { randomUUID } from 'node:crypto';
import { artifactTool } from './artifact-tool.js';
import { recallTool } from './recall-tool.js';
import { cardLine, revealAllHidden } from '@grunt/core/domain/card-text.js';
import {
  COMPUTER_LIMITS,
  COMPUTER_OFF_REASON,
  COMPUTER_UNATTENDED_REASON,
  desktopTextForResult,
  isKeyCombination,
  isSensitiveKeyText,
  isUnattendedRun,
  screenContentError,
} from '@grunt/core/domain/computer-apps.js';
import { isDeferrableInAutoMode, PermissionBroker, type Decision } from '@grunt/core/domain/permissions.js';
import type { ComputerDriver } from '@grunt/core/ports/computer.js';
import {
  NO_APPROVAL_REASON,
  type ApprovalChoice,
  type ApprovalOptions,
  type ApprovalOutcome,
  type ApprovalRequest,
  type RiskClass,
  type ToolApprovalEvent,
  type ToolContext,
  type ToolProvider,
  type ToolSpec,
} from '@grunt/core/ports/tool-provider.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { ToolPolicy, ToolSource } from '@grunt/core/types/config.js';
import type { BrowserManager } from './browser/manager.js';
import { browserTool } from './browser/tool.js';
import { computerTool } from './computer-tool.js';
import { fsTools } from './fs-tools.js';
import type { McpToolDescriptor } from './mcp/client.js';
import type { McpServerManager } from './mcp/manager.js';
import { runCommandTool } from './shell-tool.js';

export interface GruntToolProviderOptions {
  /** Overridable id generator for audit row ids; defaults to `randomUUID`. */
  generateId?: () => string;
  /** Overridable clock, for deterministic duration assertions in tests. */
  now?: () => number;
  /** The model's browser (spec 2026-10-12-model-browser-design). Without it, no profile gets the browser tool. */
  browser?: BrowserManager;
  /** The desktop shell's computer-use driver (spec 2026-10-12-computer-use-design); absent everywhere but the desktop app on Windows. */
  computer?: ComputerDriver;
}

const BUILTIN_FS_TOOLS: ToolSpec[] = fsTools;
const BUILTIN_SHELL_TOOLS: ToolSpec[] = [runCommandTool];

interface ToolError {
  /** The line that says the message holds content from outside (today: `COMPUTER_SCREEN_ABOUT`), first when there. */
  about?: string;
  error: true;
  code: string;
  message: string;
}

type Authorization = (
  | { ok: true; grantedBy: string }
  | {
      ok: false;
      code: 'permission_denied' | 'approval_denied' | 'cancelled' | 'approval_dropped' | 'approval_unavailable' | 'no_approval';
      reason: string;
      grantedBy: 'deny:policy' | 'deny:user' | 'deny:cancelled' | 'deny:unattended';
      /**
       * The line that says whose words `reason` may hold, when they may not
       * be Grunt's own (`quoting`). The model reads it first, on every path.
       */
      about?: string;
    }
) & {
  /** The machine a person answered on, when it wasn't this one (v2 spec §3). */
  decidedOnNode?: string;
};

type Denied = Extract<Authorization, { ok: false }>;

/**
 * Why a pending approval ended: a person answered it, its turn ended, the
 * broker's backstop dropped it, or the broker refused the answer itself
 * (computer use only: see `awaitApproval`).
 */
type SettleCause = 'user' | 'turn-ended' | 'dropped' | 'answer-refused';

/**
 * A call that was refused before the broker decided. `unattended`: because
 * nobody is there to watch it. `quoted`: the tool itself refused it while
 * describing it (or threw), so the reason may hold words that are not Grunt's
 * (the computer tool passes on what the desktop app said, the browser quotes
 * the address it was sent).
 */
interface Refused {
  refuse: string;
  unattended?: true;
  quoted?: true;
}

/**
 * What became of one call once every rule had its say (`decideCall`). `args`
 * is what the audit row is about: the described arguments when the call got
 * as far as being described, the model's own otherwise.
 */
type CallDecision =
  /** Approved: `args` are the described arguments, the only ones that may run. */
  | { kind: 'approved'; args: unknown; grantedBy: string; decidedOnNode?: string }
  /** Not approved, for whatever reason (a rule, the person, a stop). Nothing runs. */
  | { kind: 'refused'; args: unknown; denied: Denied }
  /** Handed to Claude Code's own classifier (auto mode, `requestApproval` only). */
  | { kind: 'deferred'; args: unknown };

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

const CANCELLED_REASON = 'The turn was stopped before this tool call was approved, so it did not run. Nobody denied it.';
const STOPPED_BEFORE_RUN_REASON = 'The turn was stopped before this tool call ran, so it did not run. Nobody denied it.';
const DROPPED_REASON = 'This approval request was dropped by the server (too many were pending), so the tool call did not run. Nobody denied it.';
const ANSWER_REFUSED_REASON = "Grunt couldn't accept that answer to the approval, so the tool call did not run and nothing was stored.";
const UNCHECKED_REASON = "Grunt couldn't check this call:";

function cancelledAuth(reason: string = CANCELLED_REASON): Denied {
  return { ok: false, code: 'cancelled', reason, grantedBy: 'deny:cancelled' };
}

/** A refusal by the rules. One made because the run is unattended keeps its own name in the audit. */
function deniedAuth(reason: string, unattended: boolean): Denied {
  return unattended
    ? { ok: false, code: 'approval_unavailable', reason, grantedBy: 'deny:unattended' }
    : { ok: false, code: 'permission_denied', reason, grantedBy: 'deny:policy' };
}

function toolError(code: string, message: string, about?: string): ToolError {
  return about === undefined ? { error: true, code, message } : { about, error: true, code, message };
}

/**
 * The tools whose calls are about a screen or a web page: what goes into
 * their approval, their audit row and their result can come from there, so
 * every string of theirs is cleaned on the way, and a throw anywhere in
 * deciding or running one ends the call instead of escaping.
 */
function isScreenTool(source: ToolSource): source is 'browser' | 'computer' {
  return source === 'browser' || source === 'computer';
}

/** A message that isn't Grunt's own (an error's, a tool's), as one clean bounded line. */
function messageOf(err: unknown): string {
  return desktopTextForResult(err instanceof Error ? err.message : String(err)) || 'no reason was given';
}

/**
 * A refusal whose reason may hold words that are not Grunt's own: what a tool
 * said while describing a call, what an error said, the broker naming a
 * program. For computer use it is rebuilt by core's one builder
 * (`screenContentError`): the reason as one clean line, and the line that
 * says it is content from the screen, which every path then puts first (the
 * API model's error result, Claude Code's denial). The provider's own fixed
 * sentences (computer use is off, nobody is there, the turn was stopped, the
 * request was dropped, the user denied it) never come through here: nothing
 * in them was written by anyone but Grunt.
 */
function quoting(tool: ToolSpec, denied: Denied): Denied {
  if (tool.source !== 'computer') return denied;
  const { about, message } = screenContentError(denied.code, denied.reason);
  return { ...denied, reason: message, about };
}

/** The error result a refused call is answered with. */
function refusalResult(denied: Denied): ToolError {
  return toolError(denied.code, denied.reason, denied.about);
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

/**
 * The arguments as the audit keeps them, for EVERY audit row of every path
 * (`auditCall` and `recordAgentDenial` both come through here). For the
 * browser and for computer use:
 *
 *   - the text typed is redacted like file content: it may be something the
 *     user asked the model to type (spec 2026-10-12-model-browser-design §3,
 *     spec 2026-10-12-computer-use-design);
 *   - every other string is kept with nothing hidden in it (`visible`). The
 *     described arguments are clean already (a window's title is core's one
 *     clean line, a page element is `pageText`'s); the model's own arguments,
 *     which is what a refused call's row holds, can carry anything, a forged
 *     `appTitle` with a right-to-left override included.
 */
function auditArgs(source: ToolSource, args: unknown): unknown {
  return isScreenTool(source) ? visible(withoutTypedText(args, source)) : args;
}

/**
 * `value` with every hidden, control or bidi character in any string of it
 * (keys included) spelled out as `<U+202E>`: the audit says what was there
 * instead of showing a line that reads differently from what it is.
 */
function visible(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return revealAllHidden(value);
  if (depth > MAX_REDACT_DEPTH || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => visible(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[revealAllHidden(key)] = visible(v, depth + 1);
  return out;
}

/**
 * `args` without the text a call would type. The browser's `text` is always
 * typed text. The computer tool's `text` is typed text or one key
 * combination. A combination is kept only when it says what was pressed and
 * holds nothing typed (core's `isSensitiveKeyText`): one with ctrl or alt
 * (`ctrl+s`), or a key that types nothing (`return`, `shift+tab`, `f5`). A
 * bare or shift-only key that types a character (`a`, `shift+a`, `7`) is
 * `[redacted: 1 key]`: a password entered one `key` action at a time must not
 * be readable a character per row. Anything else under `text` (a `key` action
 * carrying a sentence, a click carrying text) is typed text: only its length
 * is kept.
 */
function withoutTypedText(args: unknown, source: 'browser' | 'computer'): unknown {
  if (typeof args !== 'object' || args === null || !('text' in args)) return args;
  const a = args as Record<string, unknown>;
  if (source === 'browser') return { ...a, text: '[redacted]' };
  const text = a['text'];
  if (a['action'] === 'key' && isKeyCombination(text)) return isSensitiveKeyText(text) ? { ...a, text: '[redacted: 1 key]' } : args;
  if (typeof text !== 'string') return { ...a, text: '[redacted]' };
  let characters = 0;
  for (const _ of text) characters += 1;
  return { ...a, text: `[redacted: ${characters} ${characters === 1 ? 'character' : 'characters'}]` };
}

/**
 * Claude Code's name for a Grunt tool that types, relayed on its per-process
 * Grunt server (`mcp__grunt_<hex>__browser`, `mcp__grunt_<hex>__computer`),
 * or the tool's own name. The group is which of the two it is.
 */
const RELAYED_TYPING_TOOL_NAME = /^(?:mcp__grunt_[0-9a-f]+__)?(browser|computer)$/;

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
 * A call reaches a tool by one of two paths, and both are made of the same
 * three private steps, so they cannot drift apart:
 *
 *   - `decideCall`: the reply not stopped; the call described (`describeCall`,
 *     and for computer use the profile's switch and "is anyone there" before
 *     that, so no native dialog comes up for a call that can't go ahead); the
 *     broker's decision on the DESCRIBED arguments; the card; the reply still
 *     not stopped. Its answer is approved-with-those-arguments, refused, or
 *     (Claude Code auto mode) deferred.
 *   - `runApproved`: the reply still not stopped, then the tool's `execute`
 *     with the approved arguments and nothing else, and the audit row for
 *     what came of it.
 *   - `auditCall`: every audit row, with typed text redacted and nothing
 *     hidden in any string (`auditArgs`).
 *
 * An API model's path is `gate()`: decide, then run, in one closure. Claude
 * Code's path is `requestApproval()` (decide, when its PreToolUse hook asks)
 * and, later, the `execute` of the spec `relayGruntTools` gave it, which is
 * `runRelayedCall`: it runs only an argument object `requestApproval` itself
 * approved, for the same chat, reply and profile, once. There is no bare
 * `execute` of the browser or the computer tool outside this class.
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
  /**
   * The described arguments `requestApproval` approved for a spec that
   * describes its calls, by the argument object itself: what
   * `runRelayedCall` will run, once, and for whom. Held weakly: an approval
   * nobody comes back for goes with its arguments.
   */
  private readonly approved = new WeakMap<object, Approval>();
  private readonly generateId: () => string;
  private readonly now: () => number;
  private readonly browser: BrowserManager | null;
  private readonly computer: ComputerDriver | null;

  constructor(
    private readonly store: Store,
    private readonly broker: PermissionBroker,
    /** Only `listFor`/`refresh`/`shutdown` are used -- narrowed to these so a test can supply a minimal fake instead of a real `McpServerManager` with live connections. */
    private readonly mcp: Pick<McpServerManager, 'listFor' | 'refresh' | 'shutdown'>,
    options: GruntToolProviderOptions = {}
  ) {
    this.generateId = options.generateId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.browser = options.browser ?? null;
    this.computer = options.computer ?? null;
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
    // The model's browser (spec 2026-10-12-model-browser-design): off unless the profile turns it on.
    if (policy.browser === true && this.browser) raw.push(browserTool(this.browser, policy));
    // Computer use (spec 2026-10-12-computer-use-design section 4): only when the
    // profile turns it on AND the desktop shell on this machine can carry it out.
    if (policy.computer === true && this.computer?.available()) raw.push(computerTool(this.computer, this.store));
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

  /**
   * Grunt's own tools for the Claude Code relay: the browser and the computer
   * tool, each when the profile turns it on (and, for computer use, the
   * desktop shell can carry it out). The Claude Code gate approves each call
   * through `requestApproval`, which hands back the described arguments, and
   * the engine keeps them as an approval ticket.
   *
   * Unlike `relayMcpTools`, these are not bare specs: each one's `execute` is
   * `runRelayedCall`, which runs only an argument object `requestApproval`
   * approved, once, for the chat, reply and profile it approved it for, and
   * writes the audit row for what came of it. So whatever calls it, and with
   * whatever, nothing runs that no approval stands behind.
   */
  relayGruntTools(policy: ToolPolicy): ToolSpec[] {
    const specs: ToolSpec[] = [];
    if (policy.browser === true && this.browser) specs.push(this.relayed(browserTool(this.browser, policy)));
    if (policy.computer === true && this.computer?.available()) specs.push(this.relayed(computerTool(this.computer, this.store)));
    return specs;
  }

  private relayed(tool: ToolSpec): ToolSpec {
    return { ...tool, execute: (args: unknown, ctx: ToolContext): Promise<unknown> => this.runRelayedCall(tool, args, ctx) };
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

  recordAgentDenial(ctx: ToolContext, toolName: string, args: unknown, reason: string): void {
    // The classifier's own words, as one clean line: they are shown as this row's summary.
    const text = cardLine(reason, Number.POSITIVE_INFINITY) || 'Blocked by Claude Code auto mode.';
    // redact() truncates a long string exactly as it does audit args.
    // The relayed browser's and computer tool's arguments are kept as their own audit rows keep them (`auditArgs`).
    const typing = RELAYED_TYPING_TOOL_NAME.exec(toolName)?.[1];
    const audited = typing === 'browser' || typing === 'computer' ? auditArgs(typing, args) : args;
    this.writeAudit(ctx, toolName, audited, null, 0, 'deny:auto', redact(text) as string);
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
    if (tool.source === 'computer') {
      if (policy.computer !== true) return { refuse: COMPUTER_OFF_REASON };
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
   *      which throws away whatever the model put in the fields Grunt fills
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
      const denied = deniedAuth(call.refuse, call.unattended === true);
      return { kind: 'refused', args: raw, denied: call.quoted === true ? quoting(tool, denied) : denied };
    }
    let decision: Decision;
    try {
      decision = this.broker.decide(call.tool, call.args, policy, ctx);
    } catch (err) {
      // As before for every other source: the failure is the caller's to see.
      if (!isScreenTool(tool.source)) throw err;
      // The browser and computer use fail closed, on the record: the call is refused and audited.
      console.error(`[GruntToolProvider] the broker could not decide a "${tool.name}" call: ${messageOf(err)}`);
      return { kind: 'refused', args: call.args, denied: quoting(tool, deniedAuth(`${UNCHECKED_REASON} ${messageOf(err)}`, false)) };
    }
    if (decision.kind === 'ask' && opts.deferAsk === true && isDeferrableInAutoMode(call.tool, call.args)) {
      // Auto mode: Claude Code's classifier decides this call. No card, no
      // event and nothing stored -- the pending request is dropped unanswered.
      this.broker.discard(decision.request.id);
      return { kind: 'deferred', args: call.args };
    }
    const auth = await this.settle(decision, ctx, tool);
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
      result = tool.source === 'computer' ? screenContentError('computer_failed', messageOf(err)) : toolError('browser_error', messageOf(err));
    }
    this.auditCall(ctx, tool, call.args, result, this.now() - startedAt, call.grantedBy, undefined, call.decidedOnNode);
    return result;
  }

  /**
   * The `execute` of a spec handed to the Claude Code relay
   * (`relayGruntTools`). It runs `args` only when they are the very argument
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
   * Turns a broker decision into an authorisation, raising (and waiting on) an approval card for 'ask'.
   * `tool` is the spec the call came in on: a denial of a computer call that may name something on the
   * machine is cleaned and labelled (`quoting`); one made because nobody is there is Grunt's own sentence.
   */
  private async settle(decision: Decision, ctx: ToolContext, tool: ToolSpec): Promise<Authorization> {
    if (decision.kind === 'deny') {
      const denied = deniedAuth(decision.reason, decision.unattended === true);
      return decision.unattended === true ? denied : quoting(tool, denied);
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
    const pending = this.awaitApproval(request, ctx.signal);
    this.notify({ type: 'request', request });
    const { choice, cause, refusal, decidedOnNode } = await pending;
    this.notify({ type: 'resolved', requestId: request.id, messageId: request.messageId, choice: choice.choice });
    const on = decidedOnNode ? { decidedOnNode } : {};
    if (cause === 'turn-ended') return cancelledAuth();
    // The broker's reason names the program the card was about: not Grunt's own words alone.
    if (cause === 'answer-refused') return { ...quoting(tool, deniedAuth(refusal ?? ANSWER_REFUSED_REASON, false)), ...on };
    if (cause === 'dropped') return { ok: false, code: 'approval_dropped', reason: DROPPED_REASON, grantedBy: 'deny:cancelled', ...on };
    if (choice.choice === 'deny') return { ok: false, code: 'approval_denied', reason: 'The user denied this tool call.', grantedBy: 'deny:user', ...on };
    return { ok: true, grantedBy: `ask:${choice.choice}`, ...on };
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
   *
   * When the broker refuses the answer itself (it throws): for computer use
   * the call is DENIED (cause `answer-refused`, with the broker's reason).
   * Such an answer is a "for this chat" or "always" for an app that only
   * ever gets "allow once", or an "always" naming another app than the card
   * did; the card offers neither, so nothing a person was shown stands
   * behind it, and the call must not run on its strength. Every other source
   * keeps what it always did: the failure is logged and the call goes ahead
   * on the answer, with no grant stored.
   */
  private awaitApproval(
    request: ApprovalRequest,
    signal: AbortSignal
  ): Promise<{ choice: ApprovalChoice; cause: SettleCause; refusal?: string; decidedOnNode?: string }> {
    const requestId = request.id;
    return new Promise((resolve) => {
      let done = false;
      const settle = (choice: ApprovalChoice, cause: SettleCause, decidedOnNode?: string): void => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(requestId);
        let final = choice;
        let refusal: string | undefined;
        if (cause === 'dropped' || !this.broker.hasPending(requestId)) {
          // The broker no longer knows this request, so it can neither record
          // a grant nor vouch for the call. Fail closed.
          final = { choice: 'deny' };
        } else {
          try {
            this.broker.resolve(requestId, choice);
          } catch (err) {
            if (request.source === 'computer') {
              // The broker's message names the program: one clean line of it, in the log as in the refusal.
              console.error(`[GruntToolProvider] broker.resolve("${requestId}") failed: ${messageOf(err)}`);
              final = { choice: 'deny' };
              refusal = `${ANSWER_REFUSED_REASON} ${messageOf(err)}`;
            } else {
              console.error(`[GruntToolProvider] broker.resolve("${requestId}") failed:`, err);
            }
          }
        }
        resolve({
          choice: final,
          cause: refusal !== undefined ? 'answer-refused' : cause === 'user' && final.choice === 'deny' && choice.choice !== 'deny' ? 'dropped' : cause,
          ...(refusal !== undefined ? { refusal } : {}),
          ...(decidedOnNode ? { decidedOnNode } : {}),
        });
      };
      const onAbort = (): void => settle({ choice: 'deny' }, 'turn-ended');
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(requestId, settle);
    });
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

  /** Writes one audit row. `args` must already be what the audit may keep: only `auditCall` and `recordAgentDenial` call this. */
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
