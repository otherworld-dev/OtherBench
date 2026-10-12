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
    profileId: req.profile.id,
    workspaceRoot: req.workspaceRoot,
    ...(req.folders && req.folders.length > 0 ? { folders: req.folders } : {}),
    signal,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(req.subagents ? { subagents: req.subagents } : {}),
    ...(req.subagent ? { subagent: req.subagent } : {}),
  };
}
