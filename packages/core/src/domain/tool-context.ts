import type { EngineRequest } from '../ports/chat-engine.js';
import type { ToolContext } from '../ports/tool-provider.js';

/**
 * The one place a `ToolContext` is built from an `EngineRequest`, so no
 * engine forgets a field: ids, profile, workspace, extra folders, the
 * reply's plan gate, the unattended flag, and the sub-agent host and tag.
 * The AI SDK engine's `buildToolSet`, the Claude Code engine's gate and every
 * `MockChatEngine` tool branch use it. `signal` is the call's own signal when
 * the engine has one (the AI SDK's per-call abort), else the turn's; the AI
 * SDK also passes the call id.
 */
export function toolContextFor(req: EngineRequest, signal: AbortSignal = req.signal, toolCallId?: string): ToolContext {
  return {
    chatId: req.chatId,
    messageId: req.messageId,
    // A sub-agent's calls are scoped to the PARENT reply's profile, not the
    // one it runs as: otherwise a parent with no grants could pick a profile
    // that has some and get writes through with no card. This overrides the
    // spec's per-profile choice for safety (ledgered in progress.md).
    profileId: req.subagent?.parentProfileId ?? req.profile.id,
    workspaceRoot: req.workspaceRoot,
    ...(req.folders && req.folders.length > 0 ? { folders: req.folders } : {}),
    ...(req.plan ? { plan: req.plan } : {}),
    ...(req.unattended === true ? { unattended: true } : {}),
    signal,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(req.subagents ? { subagents: req.subagents } : {}),
    ...(req.subagent ? { subagent: req.subagent } : {}),
  };
}
