import type { TurnInput, TurnResult } from '@otherbench/core/domain/turn.js';
import type { Container } from './container.js';

/** What starting a turn needs from the container. */
export type TurnStartDeps = Pick<Container, 'store' | 'turnRunner' | 'streamRegistry' | 'memory' | 'events'>;

/**
 * Starts a turn the way `POST /chats/:id/turns` does once its body is valid,
 * so a scheduled turn (schedule/service.ts) is announced, streamed and
 * summarised like any other: project memory hears the chat isn't quiet, the
 * runner creates the rows, the stream registry gets their buffers before any
 * client can subscribe, the head moves to the new user message in the same
 * update that marks the chat active, and `turn-started` goes out.
 * Rethrows whatever `turnRunner.run` throws (the route maps
 * `InvalidAttachmentReferenceError` to a 400), after re-arming memory.
 */
export async function startTurn(container: TurnStartDeps, input: TurnInput): Promise<TurnResult> {
  // The chat isn't quiet any more (project memory, spec §2). Before run(), so a fast reply's new quiet timer is never cancelled.
  container.memory?.noteTurnStarted(input.chatId);
  let result: TurnResult;
  try {
    result = await container.turnRunner.run(input);
  } catch (err) {
    // Nothing started, so the chat is quiet again.
    container.memory?.noteTurnCompleted(input.chatId);
    throw err;
  }
  // Seeds the registry's buffers *before* any client can subscribe, so a
  // `GET /stream` racing this response never sees "unknown message" -- see
  // the StreamRegistry class doc for why this ordering matters.
  container.streamRegistry.registerTurn(input.chatId, result.assistantMessageIds);
  // The head goes to the new user message (what every client does next
  // anyway) in the same update that marks the chat active, so the
  // chat-updated event this sends never carries a stale head that would
  // undo a client's own move (Task 34). The chat also takes the profile the
  // message was sent with (a compare turn's first), so it opens on that
  // model next time, here and on every paired machine. A scheduled run keeps
  // the chat's own: it runs as the schedule's profile, not one the user chose.
  const primary = input.unattended ? undefined : input.profiles[0]?.id;
  const changesProfile = primary !== undefined && container.store.chats.get(input.chatId)?.profileId !== primary;
  container.store.chats.update(input.chatId, { headMessageId: result.userMessageId, updatedAt: Date.now(), ...(changesProfile ? { profileId: primary } : {}) });
  container.events?.emit({ type: 'turn-started', chatId: input.chatId, messageIds: result.assistantMessageIds });
  return result;
}
