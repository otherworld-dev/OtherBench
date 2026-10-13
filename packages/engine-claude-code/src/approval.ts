import { isAbsolute, relative, sep } from 'node:path';
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_PATH_ARG_KEYS, classifyAgentTool } from '@grunt/core/domain/agent-tools.js';
import { ARTIFACT_TOOL } from '@grunt/core/domain/artifacts.js';
import { AGENT_ASK_TOOL, DECLINED_QUESTION, PLAN_TOOL, UNATTENDED_QUESTION, answersByQuestion, isInvalid, parseQuestions } from '@grunt/core/domain/thread-tools.js';
import { desktopTextForResult, screenContentError } from '@grunt/core/domain/computer-apps.js';
import { RECALL_TOOL } from '@grunt/core/domain/recall.js';
import { containPath, containPathIn, type ContainedIn } from '@grunt/core/domain/paths.js';
import type { ToolContext, ToolProvider, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { ToolPolicy, ToolSource } from '@grunt/core/types/config.js';
import type { ResolvedFolder } from '@grunt/core/types/workspace.js';

/**
 * `about`: the line that says whose words a refusal's `reason` may hold, when
 * they may not be Grunt's own (the tool provider sets it for a computer call
 * refused in the desktop app's words). It is what Claude Code is told first
 * (`denialText`): a refusal reaches the model as the result of its tool call.
 */
export type GateDecision = { allow: true; updatedInput?: Record<string, unknown> } | { allow: false; reason: string; about?: string } | { defer: true };

/**
 * A refusal as Claude Code is handed it, on both of its ways in (the
 * PreToolUse hook's reason and `canUseTool`'s message): the line that says
 * whose words follow, when the refusal has one, then the reason.
 */
export function denialText(decision: { reason: string; about?: string }): string {
  return typeof decision.about === 'string' && decision.about.length > 0 ? `${decision.about}\n\n${decision.reason}` : decision.reason;
}
/**
 * `signal` is the SDK's own signal for this hook/permission call; the wait for
 * an answer ends when it or the turn's signal aborts. `mayDefer` is set only by
 * the PreToolUse hook: in auto mode a call the broker would ask about may then
 * go to Claude Code's classifier instead of a card.
 */
/**
 * `opts.own`: the call is to one of this process's own Grunt tools -- the
 * engine matched the exact per-process name (grunt-server.ts), never a name
 * alone. One of artifact, recall or plan, or `{ relay }`: a tool relayed from one of
 * Grunt's MCP servers, carrying the ToolSpec an API model would get for it
 * (spec 2026-10-11-claude-code-clean-chat-and-mcp-design §2).
 */
export type Gate = (
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: { mayDefer?: boolean; own?: GruntTool | { relay: ToolSpec }; toolUseId?: string }
) => Promise<GateDecision>;

/** Grunt's own tools on its per-process server, as the broker knows them. */
export type GruntTool = 'artifact' | 'recall' | 'plan';

const OWN_TOOLS: Record<GruntTool, { name: string; description: string; source: ToolSource }> = {
  artifact: { name: ARTIFACT_TOOL, description: 'Grunt artifact tool', source: 'artifact' },
  recall: { name: RECALL_TOOL, description: 'Grunt recall tool', source: 'recall' },
  plan: { name: PLAN_TOOL, description: 'Grunt plan tool', source: 'thread' },
};

/** When the engine was given no way to put a question to the user. */
const NO_ASK_REASON = "Grunt can't put a question to the user here. Use your judgement, carry on, and say in your reply what you assumed.";

const PATTERN_KEYS: Record<string, string> = { Glob: 'pattern', Grep: 'glob' };

/** A clean chat's refusal for any Claude Code tool that needs a folder (everything but web and internal tools). */
export const NO_FOLDER_REASON = "This chat has no folder: Claude Code's file, shell and own MCP tools aren't available.";

function isAbsoluteLike(v: string): boolean {
  return isAbsolute(v) || /^[a-zA-Z]:/.test(v) || v.startsWith('/') || v.startsWith('\\');
}

/**
 * True on Windows for an MSYS-style drive path (`/c/...`, `\c`, `/d`). Claude
 * Code rewrites `/c/...` to `C:\...` before touching the file, but
 * `containPath` would resolve it on the server's current drive (`E:\c\...`),
 * so with a drive-root workspace it would be judged contained. Such values are
 * treated as outside the workspace.
 */
export function isDriveLetterPosixPath(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && /^[\\/][a-zA-Z]([\\/]|$)/.test(value);
}

/** Everything before the first glob metachar, cut back to the last separator. */
function staticPrefix(pattern: string): string {
  const m = /[*?[{]/.exec(pattern);
  const head = m ? pattern.slice(0, m.index) : pattern;
  const cut = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'));
  return cut < 0 ? '' : head.slice(0, cut + 1);
}

/**
 * For Claude Code's file tools only (classifyAgentTool category file-read /
 * file-write; every other tool's args pass through untouched), every present
 * path key is trimmed (as Claude Code does) and resolved through
 * `containPath` -- the same gate Grunt's fs tools use. `~` paths are refused
 * (Claude Code expands them to the home dir), and so are `/c/...` paths on
 * Windows (see isDriveLetterPosixPath). The first path key also becomes
 * a workspace-relative forward-slash `path`, so `pathPrefix` grants and card
 * summaries work. Glob `pattern` / Grep `glob` values that are absolute, `~`,
 * or contain `..` must have a contained static prefix. A path outside the
 * workspace is reported as `outside`; a non-string/empty one as `unusable`.
 * Neither is ever sent to the broker.
 *
 * `folders` are the chat's extra folders (spec 2026-10-07-extra-folders): a
 * path in one is contained too (containPathIn), and its `path` is absolute,
 * since it isn't under the workspace. A file-write into a read-only one is
 * reported as `readOnly`, and never sent to the broker either.
 */
export function normaliseAgentArgs(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
  folders: readonly ResolvedFolder[] = [],
): { args: Record<string, unknown> } | { outside: string } | { unusable: string } | { readOnly: string } {
  const { category } = classifyAgentTool(toolName);
  if (category !== 'file-read' && category !== 'file-write') return { args: { ...input } };
  const contain = (raw: string): ContainedIn | null => {
    if (raw.startsWith('~') || isDriveLetterPosixPath(raw)) return null;
    try {
      return containPathIn(workspaceRoot, folders, raw);
    } catch {
      return null;
    }
  };
  let rel: string | undefined;
  for (const key of AGENT_PATH_ARG_KEYS) {
    if (!(key in input)) continue;
    const v = input[key];
    if (typeof v !== 'string' || v.trim().length === 0) return { unusable: key };
    const contained = contain(v.trim());
    if (contained === null) return { outside: v };
    if (category === 'file-write' && !contained.writable) return { readOnly: v };
    if (rel === undefined) {
      if (contained.root === workspaceRoot) {
        const r = relative(containPath(workspaceRoot, '.'), contained.path).split(sep).join('/');
        rel = r === '' ? '.' : r;
      } else {
        rel = contained.path;
      }
    }
  }
  const patKey = PATTERN_KEYS[toolName];
  const pat = patKey ? input[patKey] : undefined;
  if (typeof pat === 'string') {
    const t = pat.trim();
    if (isDriveLetterPosixPath(t)) return { outside: pat };
    if (isAbsoluteLike(t) || t.startsWith('~') || t.split(/[\\/]/).includes('..')) {
      const prefix = staticPrefix(t);
      if (t.startsWith('~') || contain(prefix === '' ? '.' : prefix) === null) return { outside: pat };
    }
  }
  return { args: rel === undefined ? { ...input } : { ...input, path: rel } };
}

export function createGate(deps: {
  approvals: Pick<ToolProvider, 'requestApproval'> & Partial<Pick<ToolProvider, 'askUser'>>;
  policy: ToolPolicy;
  ctx: ToolContext;
  autoMode?: boolean;
  /** Keeps what the broker approved for a relayed call whose spec describes its calls (an approval ticket, spec 2026-10-12-model-browser-design §4). */
  onApproved?: (spec: ToolSpec, input: Record<string, unknown>, args: unknown) => void;
}): Gate {
  /** AskUserQuestion: the question card, answered through `updatedInput` (spec 2026-10-12-thread-cards-design section 6). */
  const askQuestion = async (input: Record<string, unknown>, signal: AbortSignal): Promise<GateDecision> => {
    const questions = parseQuestions(input);
    if (isInvalid(questions)) return { allow: false, reason: questions.invalid };
    if (!deps.approvals.askUser) return { allow: false, reason: NO_ASK_REASON };
    const outcome = await deps.approvals.askUser({ ...deps.ctx, signal }, { kind: 'question', toolName: AGENT_ASK_TOOL, questions });
    if ('unattended' in outcome) return { allow: false, reason: UNATTENDED_QUESTION };
    if ('cancelled' in outcome) return { allow: false, reason: 'The turn was stopped.' };
    if (!('answers' in outcome.reply)) return { allow: false, reason: DECLINED_QUESTION };
    return { allow: true, updatedInput: { ...input, answers: answersByQuestion(questions, outcome.reply.answers) } };
  };

  const decide: Gate = async (toolName, input, callSignal, opts) => {
    // Grunt's own tools have no path arguments; each is checked as
    // Grunt's (the profile's switch, no card), never as an MCP tool. A
    // relayed tool is checked exactly as an API model's call to it would be.
    const own = opts?.own;
    const relay = typeof own === 'object' ? own.relay : undefined;
    const ownTool = typeof own === 'string' ? own : undefined;
    // No approval card for a turn that is already dead. A relayed tool's call
    // goes on to the tool provider all the same, which refuses it as it does
    // an API model's (nothing is asked, described or run) and puts the stop
    // on record: the same audit row on either path.
    if (relay === undefined) {
      if (deps.ctx.signal.aborted) return { allow: false, reason: 'The turn was stopped.' };
      if (callSignal?.aborted) return { allow: false, reason: 'Claude Code stopped waiting for this tool call.' };
    }
    // A pending card is settled as a denial when either the turn stops or
    // Claude Code gives up on the call (e.g. the hook timed out), so no
    // card is left waiting for a call that no longer exists.
    const signal = callSignal ? AbortSignal.any([deps.ctx.signal, callSignal]) : deps.ctx.signal;
    try {
      const workspaceRoot = deps.ctx.workspaceRoot;
      // With no folder (a clean chat) only Grunt's own tools, web tools and
      // Claude Code's internal ones (TodoWrite, AskUserQuestion) may go on.
      const category = classifyAgentTool(toolName).category;
      if (!workspaceRoot && !own && category !== 'web' && category !== 'internal') return { allow: false, reason: NO_FOLDER_REASON };
      const normalised = own || !workspaceRoot ? { args: { ...input } } : normaliseAgentArgs(toolName, input, workspaceRoot, deps.ctx.folders ?? []);
      if ('outside' in normalised) {
        return { allow: false, reason: `"${toolName}" was blocked: ${normalised.outside} is outside this chat's workspace folder.` };
      }
      if ('readOnly' in normalised) {
        return { allow: false, reason: `"${toolName}" was blocked: ${normalised.readOnly} is in a read-only folder.` };
      }
      if ('unusable' in normalised) {
        return { allow: false, reason: `"${toolName}" was blocked: it has an unusable path argument (${normalised.unusable}).` };
      }
      const spec: ToolSpec = relay ?? {
        name: ownTool ? OWN_TOOLS[ownTool].name : toolName,
        description: ownTool ? OWN_TOOLS[ownTool].description : 'Claude Code tool',
        parameters: {},
        risk: ownTool ? 'read' : classifyAgentTool(toolName).risk,
        source: ownTool ? OWN_TOOLS[ownTool].source : 'agent',
        execute: async () => undefined, // never called: Claude Code executes its own tools
      };
      // Only the PreToolUse hook, and only in auto mode, may hand a call to
      // Claude Code's classifier. canUseTool (reached when the classifier
      // can't decide) always gets a card.
      const deferAsk = deps.autoMode === true && opts?.mayDefer === true;
      const outcome = await deps.approvals.requestApproval(spec, normalised.args, deps.policy, { ...deps.ctx, signal }, { deferAsk });
      if ('deferred' in outcome && outcome.deferred === true) {
        return deferAsk ? { defer: true } : { allow: false, reason: 'Grunt could not check this tool call: unexpected deferral.' };
      }
      if (!('allowed' in outcome)) return { allow: false, reason: 'Grunt could not check this tool call: unrecognised approval outcome.' };
      if (!outcome.allowed) return { allow: false, reason: outcome.reason, ...(typeof outcome.about === 'string' ? { about: outcome.about } : {}) };
      // A relayed tool that describes its calls (the browser, computer use): keep what was approved, so only that runs.
      if (relay?.describeCall && outcome.args !== undefined) deps.onApproved?.(relay, input, outcome.args);
      // Allowed (internal, by policy): Claude Code's question now goes to the user as a card.
      if (!own && toolName === AGENT_ASK_TOOL) return await askQuestion(normalised.args, signal);
      return { allow: true };
    } catch (err) {
      return couldNotCheck(err, relay?.source === 'computer');
    }
  };

  // Claude Code can ask about one call twice (the hook, then canUseTool); one
  // question gets one card, so its decision is kept per tool use id for the reply.
  const asked = new Map<string, Promise<GateDecision>>();
  return (toolName, input, callSignal, opts) => {
    const id = opts?.toolUseId;
    if (id === undefined || opts?.own !== undefined || toolName !== AGENT_ASK_TOOL) return decide(toolName, input, callSignal, opts);
    const earlier = asked.get(id);
    if (earlier) return earlier;
    const decision = decide(toolName, input, callSignal, opts);
    asked.set(id, decision);
    return decision;
  };
}

/**
 * Claude Code's name for the computer tool relayed on a Grunt server
 * (`mcp__grunt_<hex>__computer`): what `safely` has to go on when the gate
 * itself threw before it could say which tool the call was for.
 */
const RELAYED_COMPUTER_TOOL_NAME = /^mcp__grunt_[0-9a-f]+__computer$/;

/**
 * A check that threw, as the denial Claude Code is handed. The error's words
 * are not Grunt's own (they can quote anything a tool or the desktop app
 * said): one clean line of at most 300 characters. For a computer call they
 * go under the line that says they may be from the screen (core's builder,
 * as the relay's error results do), which `denialText` puts first.
 */
function couldNotCheck(err: unknown, computer: boolean): Extract<GateDecision, { allow: false }> {
  const said = desktopTextForResult(err instanceof Error ? err.message : String(err)) || 'no reason was given';
  if (!computer) return { allow: false, reason: `Grunt could not check this tool call: ${said}` };
  const { about, message } = screenContentError('computer_failed', `Grunt could not check this tool call: ${said}`);
  return { allow: false, reason: message, about };
}

async function safely(gate: Gate, toolName: string, input: Record<string, unknown>, signal: AbortSignal | undefined, opts?: { mayDefer?: boolean; toolUseId?: string }): Promise<GateDecision> {
  try {
    return await gate(toolName, input, signal, opts);
  } catch (err) {
    return couldNotCheck(err, RELAYED_COMPUTER_TOOL_NAME.test(toolName));
  }
}

/**
 * The hook answer for a call Grunt hands to Claude Code's auto-mode classifier.
 * It is an EMPTY result: no hookSpecificOutput, no permissionDecision. The live
 * probe (test/fixtures/README.md) showed that `permissionDecision: 'defer'`
 * does not hand off -- it pauses the turn (terminal_reason 'tool_deferred') --
 * whereas giving no decision lets the classifier decide.
 */
const DEFER_TO_AUTO_MODE = {} as const;

/** The primary gate: runs for every tool call before Claude Code applies settings rules or prompts. */
export function preToolUseHook(gate: Gate): HookCallback {
  return async (input, toolUseId, options) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const id = toolUseId ?? input.tool_use_id;
    const decision = await safely(gate, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, options?.signal, { mayDefer: true, ...(id ? { toolUseId: id } : {}) });
    if ('defer' in decision) return { ...DEFER_TO_AUTO_MODE };
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.allow ? 'allow' : 'deny',
        permissionDecisionReason: decision.allow ? 'Approved in Grunt' : denialText(decision),
        // AskUserQuestion's answers ride on the input (the CLI's "hook satisfied user interaction via updatedInput").
        ...(decision.allow && decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
      },
    };
  };
}

/** Fallback for any permission prompt Claude Code still raises after the hook. Never defers. */
export function canUseToolFor(gate: Gate): CanUseTool {
  return async (toolName, input, options) => {
    const decision = await safely(gate, toolName, input, options?.signal, options?.toolUseID ? { toolUseId: options.toolUseID } : undefined);
    // Unreachable (the gate defers only for mayDefer), but fail closed.
    if ('defer' in decision) return { behavior: 'deny', message: 'Grunt could not check this tool call.' };
    return decision.allow ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input } : { behavior: 'deny', message: denialText(decision) };
  };
}

const DENIAL_FALLBACK_REASON = 'Blocked by Claude Code auto mode.';
const MAX_TOOL_NAME = 200;

/**
 * Auto mode only: records each call Claude Code's classifier blocked in
 * Grunt's audit trail (grantedBy `deny:auto`, the classifier's reason as the
 * summary). The payload comes from Claude Code, so it is coerced here. It
 * never changes the outcome and never throws.
 */
export function permissionDeniedHook(deps: { approvals: Pick<ToolProvider, 'recordAgentDenial'>; ctx: ToolContext }): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PermissionDenied') return {};
    try {
      const p = input as unknown as Record<string, unknown>;
      const toolName = (typeof p.tool_name === 'string' ? p.tool_name : String(p.tool_name ?? 'unknown')).slice(0, MAX_TOOL_NAME);
      const rawInput = p.tool_input;
      const raw: Record<string, unknown> = rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput) ? (rawInput as Record<string, unknown>) : {};
      const reason = typeof p.reason === 'string' && p.reason.trim().length > 0 ? p.reason : DENIAL_FALLBACK_REASON;
      let args: Record<string, unknown> = raw;
      try {
        const root = deps.ctx.workspaceRoot;
        const normalised = root ? normaliseAgentArgs(toolName, raw, root, deps.ctx.folders ?? []) : null;
        if (normalised && 'args' in normalised) args = normalised.args;
      } catch {
        // keep the raw args
      }
      deps.approvals.recordAgentDenial(deps.ctx, toolName, args, reason);
    } catch (err) {
      console.error('[engine-claude-code] could not record an auto-mode denial:', err);
    }
    return {};
  };
}
