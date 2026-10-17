import { randomUUID } from 'node:crypto';
import { contextPart } from '@otherbench/core/domain/context-lines.js';
import { stopBackgroundSubagents } from '@otherbench/core/domain/reconcile.js';
import type { Container } from './container.js';

/** What writing a clear line needs from the container. */
export type ClearLineDeps = Pick<Container, 'store' | 'engine' | 'streamRegistry' | 'events'>;

/**
 * A `/clear` (spec 2026-10-17-claude-slash-commands): a user message holding
 * only the clear line, under `parentId`, with no reply. The chat's head moves
 * to it, and the chat's Claude Code processes are closed, so its next reply
 * starts a fresh session and its background helpers end. Their cards end as
 * stopped: the engine's own close does that through the background-event path
 * (handleBackground), and any card still left working in a reply this machine
 * wrote (no process held it) is ended here the same way a restart ends one.
 * Other windows hear `turn-started` with no replies, and reload.
 */
export function writeClearLine(container: ClearLineDeps, { chatId, parentId }: { chatId: string; parentId: string | null }): { userMessageId: string } {
  const { store } = container;
  const line = store.messages.create({
    id: randomUUID(),
    chatId,
    parentId,
    role: 'user',
    parts: [contextPart({ kind: 'clear' })],
    status: 'complete',
    error: null,
    producedBy: null,
  });
  store.chats.update(chatId, { headMessageId: line.id, updatedAt: Date.now() });
  container.engine.closeChats?.((id) => id === chatId);

  const self = store.nodes.self().id;
  let changed = false;
  for (const message of store.messages.listWithSubagentStatus('background')) {
    // A reply still being written has its cards ended by the engine's close once it finishes (handleBackground holds
    // them until then); a reply a paired machine wrote ran its helpers there.
    if (message.chatId !== chatId || message.status === 'streaming' || (message.originNode ?? self) !== self) continue;
    const parts = stopBackgroundSubagents(message.parts);
    if (!parts) continue;
    store.messages.reviseParts(message.id, parts);
    changed = true;
  }
  if (changed) container.streamRegistry.messagesChanged(chatId);

  container.events?.emit({ type: 'turn-started', chatId, messageIds: [] });
  return { userMessageId: line.id };
}
