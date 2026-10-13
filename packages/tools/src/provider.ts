import { randomUUID } from 'node:crypto';
import { artifactTool, liveToolRisks } from './artifact-tool.js';
import { canonicalJson } from '@grunt/core/domain/live-artifacts.js';
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
import { allowedWhilePlanning, isDeferrableInAutoMode, PermissionBroker, UNATTENDED_REASON, type Decision } from '@grunt/core/domain/permissions.js';
import { PLAN_REFUSAL } from '@grunt/core/domain/thread-tools.js';
import { UserAsks } from '@grunt/core/domain/user-asks.js';
import type { ComputerDriver } from '@grunt/core/ports/computer.js';
import {
  NO_APPROVAL_REASON,
  type ApprovalChoice,
  type ApprovalOptions,
  type ApprovalOutcome,
  type ApprovalRequest,
  type AskAnswerResult,
  type AskInput,
  type AskOutcome,
  type AskReply,
  type LiveCallOutcome,
  type LiveCallStatus,
  type LiveRunRequest,
  type LiveStatusRequest,
  type RiskClass,
  type ToolApprovalEvent,
  type ToolContext,
  type ToolProvider,
  type ToolSpec,
} from '@grunt/core/ports/tool-provider.js';
import type { Sandbox } from '@grunt/core/ports/sandbox.js';
import type { Store } from '@grunt/core/ports/store.js';
import { canonicalHost } from '@grunt/core/domain/network-hosts.js';
import { runsShellInSandbox, type ToolPolicy, type ToolSource } from '@grunt/core/types/config.js';
import type { BrowserManager } from './browser/manager.js';
import { browserTool, isSensitiveBrowserKey, pageFailure } from './browser/tool.js';
import { computerTool } from './computer-tool.js';
import { fsTools } from './fs-tools.js';
import { LiveCallCache, LiveCallLimiter, LiveRefusalAudit, shapeLiveResult } from './live-calls.js';
import type { McpCallResult, McpToolDescriptor } from './mcp/client.js';
import type { McpServerManager } from './mcp/manager.js';
import { SANDBOX_NETWORK_SPEC, SANDBOX_NETWORK_TOOL, sandboxRunCommandTool } from './sandbox-tool.js';
import { runCommandTool } from './shell-tool.js';
import { subagentTool } from './subagent-tool.js';
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
  /** The model's browser (spec 2026-10-12-model-browser-design). Without it, no profile gets the browser tool. */
  browser?: BrowserManager;
  /** The desktop shell's computer-use driver (spec 2026-10-12-computer-use-design); absent everywhere but the desktop app on Windows. */
  computer?: ComputerDriver;
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
      code: 'permission_denied' | 'approval_denied' | 'cancelled' | 'approval_dropped' | 'plan_mode' | 'approval_unavailable' | 'no_approval';
      reason: string;
      grantedBy: 'deny:policy' | 'deny:user' | 'deny:cancelled' | 'deny:plan' | 'deny:unattended';
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
 * nobody is there to watch it. `plan`: because its reply's plan isn't
 * approved yet (Plan mode). `quoted`: the tool itself refused it while
 * describing it (or threw), so the reason may hold words that are not Grunt's
 * (the computer tool passes on what the desktop app said, the browser quotes
 * the address it was sent).
 */
interface Refused {
  refuse: string;
  unattended?: true;
  plan?: true;
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

/** A refusal by the rules. One made because the run is unattended, or because the reply's plan waits, keeps its own name in the audit. */
function deniedAuth(reason: string, unattended: boolean, plan = false): Denied {
  if (plan) return { ok: false, code: 'plan_mode', reason, grantedBy: 'deny:plan' };
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
 * typed text; its `press` `key` follows the computer tool's rule below in the
 * browser's own key names (`isSensitiveBrowserKey`): kept when it types
 * nothing or is a shortcut, `[redacted: 1 key]` when it types a character.
 * The computer tool's `text` is typed text or one key
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
  if (typeof args !== 'object' || args === null) return args;
  const a = args as Record<string, unknown>;
  if (source === 'browser') {
    const out: Record<string, unknown> = { ...a };
    if ('text' in a) out['text'] = '[redacted]';
    if ('key' in a && isSensitiveBrowserKey(a['key'])) out['key'] = '[redacted: 1 key]';
    return out;
  }
  if (!('text' in a)) return args;
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
  private readonly liveTimeoutMs: number;
  private readonly liveCache: LiveCallCache;
  private readonly liveLimiter: LiveCallLimiter;
  private readonly liveRefusals: LiveRefusalAudit;
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
    this.sandbox = options.sandbox ?? null;
    this.liveTimeoutMs = options.liveTimeoutMs ?? LIVE_TIMEOUT_MS;
    this.liveCache = new LiveCallCache(this.now);
    this.liveLimiter = new LiveCallLimiter(this.now);
    this.liveRefusals = new LiveRefusalAudit(this.now);
    this.asks = new UserAsks((event) => this.notify(event));
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
    if (policy.browser === true && this.browser) raw.push(browserTool(this.browser, policy));
    // Computer use (spec 2026-10-12-computer-use-design section 4): only when the
    // profile turns it on AND the desktop shell on this machine can carry it out.
    if (policy.computer === true && this.computer?.available()) raw.push(computerTool(this.computer, this.store));
    raw.push(...this.mcpToolSpecs(policy.mcpServerIds));

    return this.deduplicateNames(raw).map((spec) => this.gate(spec, policy));
  }

  /**
   * Everything the Claude Code engine relays through its per-process Grunt
   * server for this policy (the engine's gate approves each call with the
   * very same spec first): the allowlisted MCP servers' tools, the sandboxed
   * run_command when the shell runs in the sandbox and this Grunt has one
   * (spec 2026-10-12-sandbox-design, "Claude Code"), and Grunt's own relayed
   * tools (`relayGruntTools`: the browser and computer use, each of which runs
   * only arguments `requestApproval` approved). Never the host run_command: a
   * profile that wants the sandbox gets it or nothing.
   */
  relayTools(policy: ToolPolicy): ToolSpec[] {
    const shell = runsShellInSandbox(policy) && this.sandbox !== null ? [this.sandboxTool(policy)] : [];
    return this.deduplicateNames([...shell, ...this.relayGruntTools(policy), ...this.relayMcpTools(policy.mcpServerIds)]);
  }

  /**
   * Only the allowlisted MCP servers' tools, ungated and deduplicated: what a
   * live artifact's declaration may name (spec 2026-10-12-live-artifacts),
   * and the MCP part of `relayTools`. Never the sandboxed run_command, the
   * browser or computer use. Never hand these to a model directly.
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
      auth = await this.settle(this.broker.decide(SANDBOX_NETWORK_SPEC, args, policy, asked), asked, SANDBOX_NETWORK_SPEC);
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
    this.writeAudit(ctx, toolName, args, result, durationMs, grantedBy, `${summarizeResult(result)}${note}`);
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
      console.error(`[GruntToolProvider] the broker could not decide a "${tool.name}" call: ${messageOf(err)}`);
      return { kind: 'refused', args: call.args, denied: quoting(tool, deniedAuth(`${UNCHECKED_REASON} ${messageOf(err)}`, false)) };
    }
    // Never in a scheduled run: nobody is there, so the call is refused below rather than handed on.
    if (decision.kind === 'ask' && opts.deferAsk === true && ctx.unattended !== true && isDeferrableInAutoMode(call.tool, call.args)) {
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
      // An engine error can quote the page: the browser's error carries the page's line, naming the site the call was approved for.
      const host = (call.args as { host?: unknown } | null)?.host;
      result = tool.source === 'computer' ? screenContentError('computer_failed', messageOf(err)) : pageFailure('browser_error', messageOf(err), typeof host === 'string' ? host : null);
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
      // Plan mode's and a scheduled run's refusals are Grunt's own sentences.
      if (decision.plan === true) return deniedAuth(decision.reason, false, true);
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
    // A scheduled run (spec 2026-10-12-scheduled-tasks-design §2): nobody can
    // answer a card, so the request is dropped unanswered -- no waiter, no
    // event -- and the call is refused with a reason the model can act on.
    // Every card path comes through here (gated tools, Claude Code's gate,
    // the sandbox's network ask), so this one check covers them all. Computer
    // use never gets this far unattended (`described` and the broker refuse
    // it first, with its own reason); `isUnattendedRun` is its fail-closed
    // reading of the same one field, kept here too.
    if (ctx.unattended === true || (tool.source === 'computer' && isUnattendedRun(ctx))) {
      this.broker.discard(request.id);
      return {
        ok: false,
        code: 'approval_unavailable',
        reason: tool.source === 'computer' ? COMPUTER_UNATTENDED_REASON : UNATTENDED_REASON,
        grantedBy: 'deny:unattended',
      };
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
   * on the answer, with no grant stored, and as what it now is: once (the
   * audit row and the `resolved` event must not claim a grant that doesn't
   * exist).
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
              // The broker stored no grant (an "always" naming another host, a
              // shell answer with no command to pin, ...). The person did say
              // yes to this call, so it runs, but as what it now is: once.
              if (choice.choice !== 'deny') final = { choice: 'once' };
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
