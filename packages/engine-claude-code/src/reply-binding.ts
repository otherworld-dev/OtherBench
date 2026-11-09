import { ARTIFACT_TOOL } from '@otherbench/core/domain/artifacts.js';
import { RECALL_TOOL } from '@otherbench/core/domain/recall.js';
import { PLAN_TOOL, runPlanCommand } from '@otherbench/core/domain/thread-tools.js';
import { toolContextFor } from '@otherbench/core/domain/tool-context.js';
import type { EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { AskInput, ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import { isClaudeLogin, type ClaudeAccountRef } from '@otherbench/core/types/claude-accounts.js';
import { createGate, permissionDeniedHook } from './approval.js';
import type { ClaudeCodeEngineDeps } from './deps.js';
import { SdkEventMapper } from './events.js';
import { HelperRegistry } from './helpers.js';
import type { LiveProcess, OtherBenchServerSwitches, TurnBinding } from './live.js';
import { claudeFolders } from './process-options.js';
import { buildRelay, currentRelayed, runRelayed, type Relay, type RelayedCall } from './relay.js';
import { ApprovalTickets } from './tickets.js';

/** How long a helper's call between replies, or a generation Claude Code didn't say whose it is, waits for this process's reader to learn which helper made it. */
export const OWNER_WAIT_MS = 500;

/**
 * What a reply binds a process's hooks to: its gate (with its tool
 * context, policy and auto mode), its own tools and relay, and the switches
 * the process key needs. A user's reply and a self-started one build it the same way.
 */
export async function prepareReply(
  deps: ClaudeCodeEngineDeps,
  req: EngineRequest,
  backend: string,
  account: ClaudeAccountRef | undefined,
  clean: boolean
): Promise<{ gateCtx: ToolContext; autoMode: boolean; own: OtherBenchServerSwitches; relay: Relay; tickets: ApprovalTickets; helpers: HelperRegistry; binding: TurnBinding; proc: { live: LiveProcess | null } }> {
  const profile = req.profile;
  // Auto mode needs the Claude login; an endpoint backend always runs in
  // default mode (spec 2026-10-03-claude-code-auto-mode-design section 4).
  const autoMode = req.autoMode === true && isClaudeLogin(backend);
  // The reply's tool context: ids, folder (none for a clean chat, whose
  // scratch folder is not a workspace), extra folders, the plan gate and the
  // unattended flag.
  const gateCtx: ToolContext = toolContextFor(req);
  const approvals = deps.approvals;
  const askUser = approvals.askUser ? (ctx: ToolContext, input: AskInput) => approvals.askUser!(ctx, input) : undefined;
  // Artifacts (Deck #896) and recall (spec 2026-10-09-recall-design): a
  // process's OtherBench server has each tool or not from its start, so the
  // switches are part of the process key.
  const { artifactTool, recallTool } = deps;
  // The profile's MCP servers, the sandboxed run_command when its shell
  // runs in the sandbox, and the browser when it is on, relayed through the
  // same server (relay.ts). A clean chat has no folder for a command to run
  // in, so it gets no run_command; it does get the browser, which needs none.
  const relayed = deps.relayTools ? (await deps.relayTools(profile.toolPolicy)).filter((s) => !(clean && s.source === 'sandbox')) : [];
  const relay = buildRelay(relayed);
  const own: OtherBenchServerSwitches = {
    artifacts: artifactTool !== undefined && profile.toolPolicy.artifacts !== false,
    recall: recallTool !== undefined && profile.toolPolicy.recall !== false,
    plan: req.plan !== undefined && askUser !== undefined,
    relay: relay.hash,
  };
  const tickets = new ApprovalTickets();
  const results = new Map<string, unknown>();
  // The helpers this reply's agent starts: the mapper records them, the gate names them on approval cards.
  const helpers = new HelperRegistry();
  // The process this reply runs in, once chosen. Its calls go to the
  // classifier while that Claude Code is in auto mode, which can change
  // mid-reply (Auto switched, refreshChatSettings); a scheduled run's never
  // does, and it uses the classifier only when its schedule allows Auto.
  const proc: { live: LiveProcess | null } = { live: null };
  const classifier = isClaudeLogin(backend) && (req.unattended !== true || autoMode);
  const binding: TurnBinding = {
    gate: createGate({
      approvals: deps.approvals,
      policy: profile.toolPolicy,
      ctx: gateCtx,
      claudeFolders: claudeFolders(deps, req.workspaceRoot, account),
      ...(req.handover === true ? { handover: true } : {}),
      autoMode: () => classifier && proc.live?.wantsAuto === true && proc.live.permissionMode === 'auto',
      helpers,
      // A call the reply's own registry can't name: its process's background tasks may (an earlier reply's helper, or this one's not read yet).
      backgroundOwner: async (toolUseId, wait) => {
        const background = proc.live?.background;
        if (!background) return null;
        return wait ? background.whenOwned(toolUseId, OWNER_WAIT_MS) : background.ownerOf(toolUseId);
      },
      onApproved: (spec, input, args, toolUseId) => tickets.add(spec.name, input, args, toolUseId),
    }),
    // Auto can be switched on mid-reply, so the classifier's blocks are audited whenever it could run.
    ...(isClaudeLogin(backend) ? { permissionDenied: permissionDeniedHook({ approvals: deps.approvals, ctx: gateCtx }) } : {}),
    ...(artifactTool && own.artifacts ? { artifact: (args: unknown) => artifactTool({ chatId: req.chatId, messageId: req.messageId, mcpServerIds: profile.toolPolicy.mcpServerIds }, args) } : {}),
    ...(recallTool && own.recall ? { recall: (args: unknown) => recallTool({ chatId: req.chatId }, args) } : {}),
    ...(own.plan && askUser ? { plan: (args: unknown) => runPlanCommand(askUser, gateCtx, args) } : {}),
    // The current reply's spec for that tool, not the one the process started
    // with (an edit to the sandbox allowlist or the browser's blocked sites
    // applies without a new process), and only if it is the kind of tool the
    // gate approved: see currentRelayed, which fails closed (the browser
    // branch's `?? spec` fallback to the old spec is not kept). A tool that
    // describes its calls then runs only with its approval ticket: runRelayed.
    // A generator's result is kept by its tool-use id for the reply's mapper.
    ...(relay.tools.size > 0
      ? {
          relay: async (approved: ToolSpec, args: unknown, call?: RelayedCall) => {
            const spec = currentRelayed(relay, approved);
            return runRelayed(spec, args, gateCtx, tickets, call, spec.source === 'media' ? (id, output) => results.set(id, output) : undefined);
          },
        }
      : {}),
    tickets,
    results,
  };
  return { gateCtx, autoMode, own, relay, tickets, helpers, binding, proc };
}

/**
 * The mapper for one reply on `live`: this process's own tools under the API engines' names, helper cards
 * noted for its background tasks, and a generator's result as its relayed call returned it (`results`).
 */
export function replyMapper(live: LiveProcess, req: EngineRequest, helpers: HelperRegistry, results: Map<string, unknown>): SdkEventMapper {
  const renames = new Map<string, string>();
  if (live.artifactTool) renames.set(live.artifactTool, ARTIFACT_TOOL);
  if (live.recallTool) renames.set(live.recallTool, RECALL_TOOL);
  if (live.planTool) renames.set(live.planTool, PLAN_TOOL);
  for (const [claudeName, apiName] of live.relayNames) renames.set(claudeName, apiName);
  const relayedResult = (id: string): unknown => {
    const held = results.get(id);
    results.delete(id);
    return held;
  };
  return new SdkEventMapper({ ...(renames.size > 0 ? { renames } : {}), helpers, relayedResult, profileId: req.profile.id, modelId: req.profile.modelId });
}
