import type { Chat } from '@otherbench/core/ports/store.js';
import type { Part } from '@otherbench/core/types/messages.js';
import { api, type TurnResult } from './api.js';
import { buildAssistantStub, buildUserStub } from './stubs.js';
import { useOtherBenchStore } from './store.js';

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
 * start box, an app home's (spec 2026-10-20-code-tab-design) and quick chat
 * (spec 2026-10-15-project-home-design §4). In a project or an app the server
 * fills in its folder and default profile.
 */
export async function startChat(opts: { projectId?: string; appId?: string; profileId?: string; chat?: Chat; text: string }): Promise<Chat> {
  let chat = opts.chat;
  if (!chat) {
    chat = await api.chats.create({
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts.appId !== undefined ? { appId: opts.appId } : {}),
      ...(opts.profileId !== undefined ? { profileId: opts.profileId } : {}),
    });
    useOtherBenchStore.getState().upsertChat(chat);
  }
  const parts: Part[] = [{ type: 'text', text: opts.text }];
  let result: TurnResult;
  try {
    result = await api.turns.create(chat.id, { parentId: null, parts, profileIds: [chat.profileId] });
  } catch (err) {
    throw new StartChatError(chat, err);
  }
  // The message has gone: a problem from here on mustn't read as a failed send, or a retry would send it twice.
  try {
    const { registerMessage, profiles } = useOtherBenchStore.getState();
    registerMessage(buildUserStub(chat, result.userMessageId, null, result.userParts ?? parts));
    // Profiles are always loaded where a chat can be started. Without one the reply still arrives with the chat's sync.
    const profile = profiles.find((p) => p.id === chat.profileId);
    if (profile) for (const id of result.assistantMessageIds) registerMessage(buildAssistantStub(chat, id, result.userMessageId, profile));
  } catch (err) {
    console.error(`[otherbench-web] sent the first message of chat ${chat.id} but couldn't show it yet; it arrives with the chat's sync:`, err);
  }
  return chat;
}
