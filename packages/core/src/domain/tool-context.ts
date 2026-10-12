import type { EngineRequest } from '../ports/chat-engine.js';
import type { ToolContext } from '../ports/tool-provider.js';

/**
 * The one place a `ToolContext` is built from an `EngineRequest`, so no
 * engine forgets a field: ids, profile, workspace, extra folders, the
 * reply's plan gate and the unattended flag. `signal` is the call's own
 * signal when the engine has one (the AI SDK's per-call abort), else the turn's.
 */
export function toolContextFor(req: EngineRequest, signal: AbortSignal = req.signal): ToolContext {
  return {
    chatId: req.chatId,
    messageId: req.messageId,
    profileId: req.profile.id,
    workspaceRoot: req.workspaceRoot,
    ...(req.folders && req.folders.length > 0 ? { folders: req.folders } : {}),
    ...(req.plan ? { plan: req.plan } : {}),
    ...(req.unattended === true ? { unattended: true } : {}),
    signal,
  };
}
