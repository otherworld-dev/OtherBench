import { isAbsolute, relative, sep } from 'node:path';
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_PATH_ARG_KEYS, classifyAgentTool } from '@grunt/core/domain/agent-tools.js';
import { containPath, containPathIn, type ContainedIn } from '@grunt/core/domain/paths.js';
import type { ToolContext, ToolProvider, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';
import type { ResolvedFolder } from '@grunt/core/types/workspace.js';

export type GateDecision = { allow: true } | { allow: false; reason: string } | { defer: true };
/**
 * `signal` is the SDK's own signal for this hook/permission call; the wait for
 * an answer ends when it or the turn's signal aborts. `mayDefer` is set only by
 * the PreToolUse hook: in auto mode a call the broker would ask about may then
 * go to Claude Code's classifier instead of a card.
 */
export type Gate = (toolName: string, input: Record<string, unknown>, signal?: AbortSignal, opts?: { mayDefer?: boolean }) => Promise<GateDecision>;

const PATTERN_KEYS: Record<string, string> = { Glob: 'pattern', Grep: 'glob' };

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

export function createGate(deps: { approvals: Pick<ToolProvider, 'requestApproval'>; policy: ToolPolicy; ctx: ToolContext; autoMode?: boolean }): Gate {
  return async (toolName, input, callSignal, opts) => {
    // No approval card for a turn that is already dead.
    if (deps.ctx.signal.aborted) return { allow: false, reason: 'The turn was stopped.' };
    if (callSignal?.aborted) return { allow: false, reason: 'Claude Code stopped waiting for this tool call.' };
    // A pending card is settled as a denial when either the turn stops or
    // Claude Code gives up on the call (e.g. the hook timed out), so no
    // card is left waiting for a call that no longer exists.
    const signal = callSignal ? AbortSignal.any([deps.ctx.signal, callSignal]) : deps.ctx.signal;
    try {
      const workspaceRoot = deps.ctx.workspaceRoot;
      if (!workspaceRoot) return { allow: false, reason: 'This chat has no workspace folder.' };
      const normalised = normaliseAgentArgs(toolName, input, workspaceRoot, deps.ctx.folders ?? []);
      if ('outside' in normalised) {
        return { allow: false, reason: `"${toolName}" was blocked: ${normalised.outside} is outside this chat's workspace folder.` };
      }
      if ('readOnly' in normalised) {
        return { allow: false, reason: `"${toolName}" was blocked: ${normalised.readOnly} is in a read-only folder.` };
      }
      if ('unusable' in normalised) {
        return { allow: false, reason: `"${toolName}" was blocked: it has an unusable path argument (${normalised.unusable}).` };
      }
      const spec: ToolSpec = {
        name: toolName,
        description: 'Claude Code tool',
        parameters: {},
        risk: classifyAgentTool(toolName).risk,
        source: 'agent',
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
      return outcome.allowed ? { allow: true } : { allow: false, reason: outcome.reason };
    } catch (err) {
      return { allow: false, reason: `Grunt could not check this tool call: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}

async function safely(gate: Gate, toolName: string, input: Record<string, unknown>, signal: AbortSignal | undefined, opts?: { mayDefer?: boolean }): Promise<GateDecision> {
  try {
    return await gate(toolName, input, signal, opts);
  } catch (err) {
    return { allow: false, reason: `Grunt could not check this tool call: ${err instanceof Error ? err.message : String(err)}` };
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
  return async (input, _toolUseId, options) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const decision = await safely(gate, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, options?.signal, { mayDefer: true });
    if ('defer' in decision) return { ...DEFER_TO_AUTO_MODE };
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.allow ? 'allow' : 'deny',
        permissionDecisionReason: decision.allow ? 'Approved in Grunt' : decision.reason,
      },
    };
  };
}

/** Fallback for any permission prompt Claude Code still raises after the hook. Never defers. */
export function canUseToolFor(gate: Gate): CanUseTool {
  return async (toolName, input, options) => {
    const decision = await safely(gate, toolName, input, options?.signal);
    // Unreachable (the gate defers only for mayDefer), but fail closed.
    if ('defer' in decision) return { behavior: 'deny', message: 'Grunt could not check this tool call.' };
    return decision.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.reason };
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
