import type { Chat } from '@grunt/core/ports/store.js';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';

/**
 * Fabricates the local stubs for a just-created turn's messages so the
 * thread updates the instant the request resolves, without waiting for a
 * `GET /chats/:id/messages` round trip -- mirrors exactly what
 * `TurnRunner.run` creates server-side (packages/core/src/domain/turn.ts).
 * Any events that arrived over the still-open SSE connection before this
 * runs are already buffered under these same ids (see store.ts's
 * `applyTurnEvent`) and get folded in the moment `registerMessage` runs.
 */
export function buildUserStub(chat: Chat, id: string, parentId: string | null, parts: Part[]): CanonMessage {
  return { id, chatId: chat.id, parentId, role: 'user', parts, status: 'complete', error: null, producedBy: null, createdAt: Date.now() };
}

export function buildAssistantStub(chat: Chat, id: string, parentId: string, profile: { id: string; name: string; connectionId: string; modelId: string }, regenerated = false): CanonMessage {
  return {
    id,
    chatId: chat.id,
    parentId,
    role: 'assistant',
    parts: [],
    status: 'streaming',
    error: null,
    producedBy: { profileId: profile.id, profileName: profile.name, connectionId: profile.connectionId, modelId: profile.modelId, ...(regenerated ? { regenerated: true } : {}) },
    createdAt: Date.now(),
  };
}
