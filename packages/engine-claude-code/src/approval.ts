import { relative, sep } from 'node:path';
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_PATH_ARG_KEYS, classifyAgentTool } from '@grunt/core/domain/agent-tools.js';
import { containPath } from '@grunt/core/domain/paths.js';
import type { ToolContext, ToolProvider, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';

export type GateDecision = { allow: true } | { allow: false; reason: string };
type Gate = (toolName: string, input: Record<string, unknown>) => Promise<GateDecision>;

/**
 * Adds a workspace-relative `path` (forward slashes) for the first path-like
 * argument, resolved through `containPath` -- the same gate Grunt's fs tools
 * use -- so `pathPrefix` grants and card summaries work for Claude Code's
 * `file_path`/`notebook_path`. A path that won't resolve inside the workspace
 * is reported as `outside` and is never sent to the broker.
 */
export function normaliseAgentArgs(input: Record<string, unknown>, workspaceRoot: string): { args: Record<string, unknown> } | { outside: string } {
  const key = AGENT_PATH_ARG_KEYS.find((k) => typeof input[k] === 'string' && (input[k] as string).length > 0);
  if (!key) return { args: { ...input } };
  const raw = input[key] as string;
  let contained: string;
  try {
    contained = containPath(workspaceRoot, raw);
  } catch {
    return { outside: raw };
  }
  const rootResolved = containPath(workspaceRoot, '.');
  const rel = relative(rootResolved, contained).split(sep).join('/');
  return { args: { ...input, path: rel === '' ? '.' : rel } };
}

export function createGate(deps: { approvals: Pick<ToolProvider, 'requestApproval'>; policy: ToolPolicy; ctx: ToolContext }): Gate {
  return async (toolName, input) => {
    // No approval card for a turn that is already dead.
    if (deps.ctx.signal.aborted) return { allow: false, reason: 'The turn was stopped.' };
    const workspaceRoot = deps.ctx.workspaceRoot;
    if (!workspaceRoot) return { allow: false, reason: 'This chat has no workspace folder.' };
    const normalised = normaliseAgentArgs(input, workspaceRoot);
    if ('outside' in normalised) {
      return { allow: false, reason: `"${toolName}" was blocked: ${normalised.outside} is outside this chat's workspace folder.` };
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
  };
}

/** The primary gate: runs for every tool call before Claude Code applies settings rules or prompts. */
export function preToolUseHook(gate: Gate): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const decision = await gate(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
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
    const decision = await gate(toolName, input);
    return decision.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.reason };
  };
}
