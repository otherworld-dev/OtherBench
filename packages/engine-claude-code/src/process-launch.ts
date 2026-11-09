import type { HookCallback, Options, PostCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { ARTIFACT_TOOL } from '@otherbench/core/domain/artifacts.js';
import { RECALL_TOOL } from '@otherbench/core/domain/recall.js';
import { createPlanGate, PLAN_TOOL } from '@otherbench/core/domain/thread-tools.js';
import type { ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import type { ToolPolicy } from '@otherbench/core/types/config.js';
import { isClaudeLogin, type ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import { canUseToolFor, createGate, permissionDeniedHook, preToolUseHook, type Gate, type OtherBenchTool } from './approval.js';
import type { ClaudeCodeEngineDeps } from './deps.js';
import { LiveProcess, PromptQueue, type OtherBenchServerSwitches } from './live.js';
import { otherBenchArtifactTool, otherBenchMcpServer, otherBenchPlanTool, otherBenchRecallTool, otherBenchServerName, otherBenchToolName, type OtherBenchServerTool } from './otherbench-server.js';
import { claudeFolders } from './process-options.js';
import { relayServerTool, type Relay } from './relay.js';
import { OWNER_WAIT_MS } from './reply-binding.js';
import type { SessionPlan } from './session.js';

/**
 * Starts a Claude Code process whose input stays open for later messages.
 * Its hooks are fixed now, so they call through `live.binding`: whichever
 * reply is running decides its tool calls, and with none running every
 * call is refused.
 */
export function launchProcess(deps: ClaudeCodeEngineDeps, options: Options, key: string, plan: SessionPlan, own: OtherBenchServerSwitches, relay: Relay, backend: string, account: ClaudeAccountRef | undefined): LiveProcess {
  // Auto mode needs a Claude login; an endpoint backend never runs in it.
  const canAuto = isClaudeLogin(backend);
  const input = new PromptQueue();
  const abortController = new AbortController();
  let live: LiveProcess | null = null;
  // OtherBench's own MCP server (Deck #896), under a name made for this process.
  // The gate passes its artifact and recall tools without a card, matching
  // those exact names, so no project MCP config can name a server to get
  // the same pass.
  const server = own.artifacts || own.recall || own.plan || relay.tools.size > 0 ? otherBenchServerName() : null;
  const ownArtifactTool = server && own.artifacts ? otherBenchToolName(server, ARTIFACT_TOOL) : null;
  const ownRecallTool = server && own.recall ? otherBenchToolName(server, RECALL_TOOL) : null;
  const ownPlanTool = server && own.plan ? otherBenchToolName(server, PLAN_TOOL) : null;
  // A relayed tool is matched by its exact name on this process's server, like artifact and recall.
  const relayed = new Map<string, ToolSpec>(server ? [...relay.tools].map(([name, spec]) => [otherBenchToolName(server, name), spec] as const) : []);
  const ownTool = (toolName: string): OtherBenchTool | { relay: ToolSpec } | undefined => {
    if (toolName === ownArtifactTool) return 'artifact';
    if (toolName === ownRecallTool) return 'recall';
    if (toolName === ownPlanTool) return 'plan';
    const spec = relayed.get(toolName);
    return spec ? { relay: spec } : undefined;
  };
  const tools: OtherBenchServerTool[] = [
    ...(own.artifacts ? [otherBenchArtifactTool(() => live?.binding?.artifact)] : []),
    ...(own.recall ? [otherBenchRecallTool(() => live?.binding?.recall)] : []),
    ...(own.plan ? [otherBenchPlanTool(() => live?.binding?.plan)] : []),
    ...[...relay.tools].map(([name, spec]) => relayServerTool(name, spec, () => live?.binding?.relay)),
  ];
  /**
   * Between replies only a background helper's own call can be approved, on
   * its helper's card (the reply that started it), with the chat's settings
   * as they are now. The last reply's signal is dead by then (TurnRunner
   * aborts it when a reply ends), so the call is tied to the process's own.
   */
  const helperContext = async (toolUseId: string | undefined): Promise<{ ctx: ToolContext; policy: ToolPolicy; autoMode: boolean } | null> => {
    const owner = live?.last && toolUseId ? await live.background?.whenOwned(toolUseId, OWNER_WAIT_MS) : null;
    if (!live?.last || !owner) return null;
    const last = live.last;
    const current = deps.chatSettings ? deps.chatSettings(last.chatId, last.profileId) : { autoMode: last.autoMode, planMode: last.ctx.plan !== undefined, policy: last.policy };
    if (!current) return null;
    const { plan: lastPlan, ...rest } = last.ctx;
    const plan = current.planMode ? (lastPlan ?? createPlanGate()) : undefined;
    return {
      ctx: { ...rest, ...(plan ? { plan } : {}), signal: abortController.signal, messageId: owner.messageId, shownSubagent: { callId: owner.callId, label: owner.label, parentProfileId: last.profileId } },
      policy: current.policy,
      // Claude Code's own mode can't change mid-process: Auto turned on since doesn't make it auto.
      // A scheduled run keeps its schedule's Auto, whatever the chat's says now.
      autoMode: (last.unattended ? last.autoMode : current.autoMode) && live.permissionMode === 'auto',
    };
  };
  const gate: Gate = async (toolName, toolInput, signal, opts) => {
    const which = ownTool(toolName);
    if (live?.binding) return live.binding.gate(toolName, toolInput, signal, { ...opts, ...(which ? { own: which } : {}) });
    const helper = which ? null : await helperContext(opts?.toolUseId);
    // A reply may have begun while this waited: its gate decides.
    if (live?.binding) return live.binding.gate(toolName, toolInput, signal, opts);
    if (!helper) return { allow: false, reason: 'No OtherBench reply is waiting on this tool call.' };
    return createGate({ approvals: deps.approvals, claudeFolders: claudeFolders(deps, helper.ctx.workspaceRoot, account), ...helper })(toolName, toolInput, signal, opts);
  };
  const permissionDenied: HookCallback = async (hookInput, toolUseId, hookOptions) => {
    if (live?.binding) return live.binding.permissionDenied ? live.binding.permissionDenied(hookInput, toolUseId, hookOptions) : {};
    // A helper's call the classifier blocked between replies is audited against its helper's reply, like any other.
    const helper = await helperContext(toolUseId ?? undefined);
    return helper ? permissionDeniedHook({ approvals: deps.approvals, ctx: helper.ctx })(hookInput, toolUseId, hookOptions) : {};
  };
  // A /compact's summary, for the reply that sent it. Claude Code compacting by itself is told by its boundary instead.
  const postCompact: HookCallback = async (hookInput) => {
    const input = hookInput as PostCompactHookInput;
    if (input.trigger === 'manual' && typeof input.compact_summary === 'string' && input.compact_summary.trim()) live?.binding?.compacted?.(input.compact_summary);
    return {};
  };
  const full: Options = {
    ...options,
    // Its tool acts for whichever reply is running, like the hooks.
    ...(server ? { mcpServers: { ...(options.mcpServers ?? {}), [server]: (deps.mcpServer ?? otherBenchMcpServer)(server, tools) } } : {}),
    abortController,
    stderr: (data: string) => {
      if (!live) return;
      live.stderr.push(data);
      if (live.stderr.length > 50) live.stderr.shift();
    },
    // The hook waits on a human; Claude Code's default hook timeout (60 s)
    // would cancel the call under an open card. 86400 s = one day.
    hooks: {
      PreToolUse: [{ hooks: [preToolUseHook(gate)], timeout: 86_400 }],
      // Classifier blocks are audited as deny:auto (auto mode only).
      // On the Claude login whatever mode it starts in: Auto can be switched on while it runs.
      ...(canAuto ? { PermissionDenied: [{ hooks: [permissionDenied] }] } : {}),
      PostCompact: [{ hooks: [postCompact] }],
    },
    canUseTool: canUseToolFor(gate),
    ...(plan.mode === 'continue' ? { resume: plan.sessionId } : {}),
  };
  const process = new LiveProcess(key, input, abortController, deps.query({ prompt: input, options: full }));
  process.permissionMode = options.permissionMode ?? 'default';
  process.canAuto = canAuto;
  process.backend = backend;
  process.account = account;
  process.artifactTool = ownArtifactTool;
  process.recallTool = ownRecallTool;
  process.planTool = ownPlanTool;
  for (const [claudeName, spec] of relayed) process.relayNames.set(claudeName, spec.name);
  live = process;
  return process;
}
