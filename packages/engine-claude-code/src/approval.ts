import { isAbsolute, relative, sep } from 'node:path';
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_PATH_ARG_KEYS, classifyAgentTool } from '@grunt/core/domain/agent-tools.js';
import { containPath } from '@grunt/core/domain/paths.js';
import type { ToolContext, ToolProvider, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';

export type GateDecision = { allow: true } | { allow: false; reason: string };
type Gate = (toolName: string, input: Record<string, unknown>) => Promise<GateDecision>;

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
 */
export function normaliseAgentArgs(
  toolName: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
): { args: Record<string, unknown> } | { outside: string } | { unusable: string } {
  const { category } = classifyAgentTool(toolName);
  if (category !== 'file-read' && category !== 'file-write') return { args: { ...input } };
  const contain = (raw: string): string | null => {
    if (raw.startsWith('~') || isDriveLetterPosixPath(raw)) return null;
    try {
      return containPath(workspaceRoot, raw);
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
    if (rel === undefined) {
      const r = relative(containPath(workspaceRoot, '.'), contained).split(sep).join('/');
      rel = r === '' ? '.' : r;
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

export function createGate(deps: { approvals: Pick<ToolProvider, 'requestApproval'>; policy: ToolPolicy; ctx: ToolContext }): Gate {
  return async (toolName, input) => {
    // No approval card for a turn that is already dead.
    if (deps.ctx.signal.aborted) return { allow: false, reason: 'The turn was stopped.' };
    try {
      const workspaceRoot = deps.ctx.workspaceRoot;
      if (!workspaceRoot) return { allow: false, reason: 'This chat has no workspace folder.' };
      const normalised = normaliseAgentArgs(toolName, input, workspaceRoot);
      if ('outside' in normalised) {
        return { allow: false, reason: `"${toolName}" was blocked: ${normalised.outside} is outside this chat's workspace folder.` };
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
      const outcome = await deps.approvals.requestApproval(spec, normalised.args, deps.policy, deps.ctx);
      return outcome.allowed ? { allow: true } : { allow: false, reason: outcome.reason };
    } catch (err) {
      return { allow: false, reason: `Grunt could not check this tool call: ${err instanceof Error ? err.message : String(err)}` };
    }
  };
}

async function safely(gate: Gate, toolName: string, input: Record<string, unknown>): Promise<GateDecision> {
  try {
    return await gate(toolName, input);
  } catch (err) {
    return { allow: false, reason: `Grunt could not check this tool call: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The primary gate: runs for every tool call before Claude Code applies settings rules or prompts. */
export function preToolUseHook(gate: Gate): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const decision = await safely(gate, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.allow ? 'allow' : 'deny',
        permissionDecisionReason: decision.allow ? 'Approved in Grunt' : decision.reason,
      },
    };
  };
}

/** Fallback for any permission prompt Claude Code still raises after the hook. */
export function canUseToolFor(gate: Gate): CanUseTool {
  return async (toolName, input) => {
    const decision = await safely(gate, toolName, input);
    return decision.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.reason };
  };
}
