import type { EngineRequest } from '../ports/chat-engine.js';
import type { ToolContext } from '../ports/tool-provider.js';

/**
 * The one place a `ToolContext` is built from an `EngineRequest`, so a new
 * field can't be missed in one engine (the AI SDK engine's `buildToolSet` and
 * every `MockChatEngine` tool branch use it). `signal` defaults to the
 * request's; the AI SDK passes its own per-call signal and the call id.
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
    signal,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(req.subagents ? { subagents: req.subagents } : {}),
    ...(req.subagent ? { subagent: req.subagent } : {}),
  };
}
