import { applySubagentEvent } from '@otherbench/core/domain/parts.js';
import type { EngineBackgroundEvent } from '@otherbench/core/ports/chat-engine.js';
import type { Container } from './container.js';
import { resolveProfile } from './profile-resolution.js';
import { startSelfStartedTurn } from './turn-start.js';

type HelperEvent = Extract<EngineBackgroundEvent, { type: 'helper-event' }>;

/** Card updates for replies still being written, per container, by reply: applied once each reply ends. */
const held = new WeakMap<Container, Map<string, HelperEvent[]>>();

/**
 * Keeps a card update for reply `event.messageId`, still being written, until
 * TurnRunner announces its end (after its last write), so that write, made
 * from what the reply knew, doesn't undo the update. Without an event bus to
 * hear the end on, it isn't held. Returns whether it was held.
 */
function holdUntilWritten(container: Container, event: HelperEvent): boolean {
  const events = container.events;
  if (!events) return false;
  let byMessage = held.get(container);
  if (!byMessage) {
    const waiting = new Map<string, HelperEvent[]>();
    byMessage = waiting;
    held.set(container, waiting);
    events.subscribe((e) => {
      if (e.type !== 'turn-finished') return;
      const due = waiting.get(e.messageId);
      if (!due) return;
      waiting.delete(e.messageId);
      for (const update of due) handleBackground(container, update);
    });
  }
  byMessage.set(event.messageId, [...(byMessage.get(event.messageId) ?? []), event]);
  return true;
}

/** How many background tasks the app-wide events last said `chatId` has. */
function countOf(container: Container, chatId: string): number {
  return container.events?.backgroundChats().find((c) => c.chatId === chatId)?.count ?? 0;
}

/**
 * What the engine reports its agent doing between replies (spec
 * 2026-10-17-claude-background-helpers-design): a chat's background tasks go
 * on that chat's stream, a helper's card in an earlier reply is brought up to
 * date (stored, and subscribers told to reload), and a turn the agent started
 * by itself is run as a reply.
 */
export function handleBackground(container: Container, event: EngineBackgroundEvent): void {
  switch (event.type) {
    case 'helpers':
      container.streamRegistry.setHelpers(event.chatId, event.helpers);
      // App-wide too, so the sidebar marks the chat whether it's open or not. The list changes with
      // every helper's progress; only a change in how many is news there (and to paired machines).
      if (container.events && countOf(container, event.chatId) !== event.helpers.length) {
        container.events.emit({ type: 'background-tasks', chatId: event.chatId, count: event.helpers.length });
      }
      return;
    case 'helper-event': {
      const message = container.store.messages.get(event.messageId);
      if (!message || message.chatId !== event.chatId) return;
      if (message.status === 'streaming' && holdUntilWritten(container, event)) return;
      const parts = applySubagentEvent(message.parts, event.callId, event.event);
      if (parts === message.parts) return;
      // Stamped for sync, so a paired machine's copy of the card updates too.
      container.store.messages.reviseParts(message.id, parts);
      container.streamRegistry.messagesChanged(event.chatId);
      return;
    }
    case 'self-start': {
      const { start } = event;
      const deps = { ...container, resolveProfile: (id: string) => resolveProfile({ store: container.store, secrets: container.secrets }, id) };
      void startSelfStartedTurn(deps, start).catch((err: unknown) => {
        console.error(`[otherbench-server] could not run a reply Claude Code started by itself in chat ${start.chatId}:`, err);
        start.decline();
      });
      return;
    }
  }
}
