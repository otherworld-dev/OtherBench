import { randomUUID } from 'node:crypto';
import { continuedTitle, isHandoverRequest, summaryOf } from '@otherbench/core/domain/handover.js';
import { isCompareSet } from '@otherbench/core/domain/tree.js';
import type { NewChat } from '@otherbench/core/ports/store.js';
import type { CanonMessage, MessageStatus } from '@otherbench/core/types/messages.js';
import { NOT_HERE } from '../claude-accounts/switcher.js';
import type { Container } from '../container.js';
import { chatIsIdle } from '../peer/forward.js';
import { resolveProfile } from '../profile-resolution.js';
import { startTurn } from '../turn-start.js';

/** Why a handover can't start, with the status and kind the route answers with. */
export class HandoverError extends Error {
  override readonly name = 'HandoverError';
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
    readonly kind: 'not_found' | 'not_here' | 'busy' | 'handover_running' | 'not_latest' | 'not_a_reply'
  ) {
    super(message);
  }
}

export const HANDOVER_BUSY = "Wait for this chat to finish what it's doing first.";
export const HANDOVER_RUNNING = 'This chat is already being handed over.';

/**
 * Hands a big Claude Code chat over to a fresh chat (spec
 * 2026-11-06-fresh-chat-handover-design). `start` checks the reply and starts
 * the summary turn in the old chat, then returns; the rest runs here whether
 * or not any window is open: once the summary is complete the new chat is
 * made with the old one's settings and the summary as its first message, the
 * two are linked, the old chat's schedules move over, and `chat-handed-over`
 * tells every window. A summary that fails or is stopped makes nothing, and
 * the chat can be handed over again. Not resumed after a restart: that
 * summary reply ends as any reply cut off by one does.
 */
export class HandoverService {
  /** Chats with a handover running, taken before the first await so a second click can't slip in. */
  private readonly running = new Set<string>();

  constructor(private readonly container: Container) {}

  isRunning(chatId: string): boolean {
    return this.running.has(chatId);
  }

  async start(chatId: string, messageId: string): Promise<{ userMessageId: string; assistantMessageIds: string[] }> {
    const { store } = this.container;
    const chat = store.chats.get(chatId);
    if (!chat) throw new HandoverError(404, `Chat "${chatId}" not found.`, 'not_found');
    if (chat.runsOn !== store.nodes.self().id) throw new HandoverError(409, NOT_HERE, 'not_here');
    const message = store.messages.get(messageId);
    if (!message || message.chatId !== chatId) throw new HandoverError(404, `Message "${messageId}" not found in this chat.`, 'not_found');
    if (!isWholeClaudeCodeReply(message)) throw new HandoverError(400, 'Only a finished Claude Code reply can be handed over.', 'not_a_reply');
    if (message.parentId !== null && isCompareSet(store.messages.children(message.parentId))) {
      throw new HandoverError(400, "A compare turn's reply can't be handed over.", 'not_a_reply');
    }
    const parent = message.parentId !== null ? store.messages.get(message.parentId) : null;
    if (parent && isHandoverRequest(parent)) throw new HandoverError(400, 'A handover summary is handed over already.', 'not_a_reply');
    if (this.running.has(chatId)) throw new HandoverError(409, HANDOVER_RUNNING, 'handover_running');
    if (!chatIsIdle(this.container, chatId) || this.container.turnRunner.runningIn(chatId).length > 0) throw new HandoverError(409, HANDOVER_BUSY, 'busy');
    // The latest reply: nothing after it but earlier handover attempts that never finished (one that did is refused above).
    if (!store.messages.children(messageId).every(isHandoverRequest)) throw new HandoverError(409, "Only the chat's latest reply can be handed over.", 'not_latest');
    this.running.add(chatId);

    let result: { userMessageId: string; assistantMessageIds: string[] };
    try {
      // The profile that wrote the reply: its session is the one that holds the chat.
      const profile = await resolveProfile(this.container, message.producedBy.profileId);
      // Only Claude Code's engine runs a handover with every tool refused; a profile moved to a model API since would not.
      if (profile.connection.kind !== 'claude_code') throw new HandoverError(400, "That reply's profile no longer runs on Claude Code, so it can't write the handover.", 'not_a_reply');
      result = await startTurn(this.container, { chatId, parentId: messageId, userParts: [{ type: 'handover-request' }], profiles: [profile] });
    } catch (err) {
      this.running.delete(chatId);
      throw err;
    }
    const summaryId = result.assistantMessageIds[0]!;
    void this.finish(chatId, summaryId)
      .catch((err: unknown) => console.error(`[handover] handing chat ${chatId} over failed:`, err))
      .finally(() => this.running.delete(chatId));
    return { userMessageId: result.userMessageId, assistantMessageIds: result.assistantMessageIds };
  }

  /** Once the summary reply ends: the new chat, its first message, the links, the schedules and the event. */
  private async finish(chatId: string, summaryId: string): Promise<void> {
    const status = await this.ended(summaryId);
    const { store } = this.container;
    const old = store.chats.get(chatId);
    const reply = store.messages.get(summaryId);
    if (status !== 'complete' || !old || !reply) return;
    const summary = summaryOf(reply);
    if (!summary) return;

    const title = continuedTitle(old.title);
    const fresh: NewChat = {
      id: randomUUID(),
      title,
      profileId: reply.producedBy?.profileId ?? old.profileId,
      headMessageId: null,
      workspace: old.workspace,
      pinned: false,
      archivedAt: null,
      autoMode: old.autoMode,
      planMode: old.planMode ?? false,
      accountAutoSwitch: old.accountAutoSwitch ?? false,
      claudeAccount: old.claudeAccount ?? null,
      projectId: old.projectId,
      appId: old.appId ?? null,
      // A chat kept out of memory stays out: its summary is the same content.
      memoryExcluded: old.memoryExcluded,
      ...(old.effort ? { effort: old.effort } : {}),
      ...(old.folders ? { folders: old.folders } : {}),
    };
    const created = store.chats.create(fresh);
    const firstId = randomUUID();
    store.messages.create({
      id: firstId,
      chatId: created.id,
      parentId: null,
      role: 'assistant',
      parts: [{ type: 'handover', direction: 'from', chatId: old.id, title: old.title }, { type: 'text', text: summary }],
      status: 'complete',
      error: null,
      producedBy: reply.producedBy,
    });
    store.chats.update(created.id, { headMessageId: firstId });

    // A schedule kept on the old chat would keep growing it, so it goes too, and the old chat's link says so.
    let moved = 0;
    for (const s of store.schedules.list()) {
      if (s.target.kind !== 'chat' || s.target.chatId !== chatId) continue;
      store.schedules.retarget(s.id, created.id);
      moved += 1;
    }
    if (moved > 0) this.container.events?.emit({ type: 'schedules-changed' });

    store.messages.updateParts(summaryId, [...reply.parts, { type: 'handover', direction: 'to', chatId: created.id, title, ...(moved > 0 ? { schedulesMoved: moved } : {}) }]);
    this.container.streamRegistry.messagesChanged(chatId);
    this.container.events?.emit({ type: 'chat-handed-over', fromChatId: chatId, toChatId: created.id, title });
  }

  /** The status the summary reply ends with. */
  private ended(messageId: string): Promise<MessageStatus> {
    return new Promise((resolve) => {
      const off = this.container.turnRunner.on((e) => {
        if (e.messageId !== messageId || e.type !== 'status' || e.status === 'streaming') return;
        off();
        resolve(e.status);
      });
      // It may have ended before anyone listened.
      const now = this.container.store.messages.get(messageId)?.status;
      if (now !== undefined && now !== 'streaming') {
        off();
        resolve(now);
      }
    });
  }
}

function isWholeClaudeCodeReply(m: CanonMessage): m is CanonMessage & { producedBy: NonNullable<CanonMessage['producedBy']> } {
  return m.role === 'assistant' && m.status === 'complete' && m.producedBy !== null && m.engineMeta?.engine === 'claude_code';
}
