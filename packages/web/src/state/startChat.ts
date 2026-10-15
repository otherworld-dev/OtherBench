import type { Chat } from '@grunt/core/ports/store.js';
import type { Part } from '@grunt/core/types/messages.js';
import { api } from './api.js';
import { buildAssistantStub, buildUserStub } from './stubs.js';
import { useGruntStore } from './store.js';

/**
 * The chat exists but its first message didn't send. The caller keeps `chat`
 * and passes it back to `startChat`, so a retry doesn't make a second chat.
 */
export class StartChatError extends Error {
  constructor(
    readonly chat: Chat,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : "Couldn't send the first message.", { cause });
    this.name = 'StartChatError';
  }
}

/**
 * Creates a chat (unless `chat` is given) and sends `text` as its first
 * message with the chat's own profile: the one path for a project page's
 * start box and quick chat (spec 2026-10-15-project-home-design §4). In a
 * project the server fills in the project's folder and default profile.
 */
export async function startChat(opts: { projectId?: string; profileId?: string; chat?: Chat; text: string }): Promise<Chat> {
  let chat = opts.chat;
  if (!chat) {
    chat = await api.chats.create({
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts.profileId !== undefined ? { profileId: opts.profileId } : {}),
    });
    useGruntStore.getState().upsertChat(chat);
  }
  const parts: Part[] = [{ type: 'text', text: opts.text }];
  try {
    const result = await api.turns.create(chat.id, { parentId: null, parts, profileIds: [chat.profileId] });
    const { registerMessage, profiles } = useGruntStore.getState();
    registerMessage(buildUserStub(chat, result.userMessageId, null, parts));
    // Profiles are always loaded where a chat can be started. Without one the reply still arrives with the chat's sync.
    const profile = profiles.find((p) => p.id === chat.profileId);
    if (profile) for (const id of result.assistantMessageIds) registerMessage(buildAssistantStub(chat, id, result.userMessageId, profile));
    return chat;
  } catch (err) {
    throw new StartChatError(chat, err);
  }
}
