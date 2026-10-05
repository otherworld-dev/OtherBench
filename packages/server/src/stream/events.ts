import type { TurnRunner } from '@grunt/core/domain/turn.js';
import type { Chat, ChatRepo, NewChat, Store } from '@grunt/core/ports/store.js';
import type { AppEvent, PendingApprovalSummary, RunningTurnSummary } from '@grunt/core/types/events.js';

/**
 * The app-wide event bus behind `GET /api/events` (v2 plan, Task 34). Chat
 * events come from `withChatEvents`, which wraps the store's chat repo so
 * every create, update and delete is announced whoever made it (a route,
 * auto-title, project memory). Turn and approval events come from the
 * `TurnRunner` via `attach`; turn starts are emitted by the turn routes,
 * which know the chat and the new reply ids.
 *
 * It also keeps the pending approvals it has seen requested and not yet
 * resolved, and the replies started and not yet finished, so a subscriber
 * that connects later starts from the right state (the `hello` event). A
 * turn ending drops whatever it still had pending: approvals end with their
 * turn.
 */
export class AppEventBus {
  private readonly listeners = new Set<(e: AppEvent) => void>();
  private readonly pending = new Map<string, PendingApprovalSummary>();
  /** Replies being written, by message id. */
  private readonly running = new Map<string, string>();

  emit(e: AppEvent): void {
    if (e.type === 'approval-requested') {
      this.pending.set(e.requestId, { chatId: e.chatId, messageId: e.messageId, requestId: e.requestId, toolName: e.toolName });
    } else if (e.type === 'approval-resolved') {
      this.pending.delete(e.requestId);
    } else if (e.type === 'turn-started') {
      for (const messageId of e.messageIds) this.running.set(messageId, e.chatId);
    } else if (e.type === 'turn-finished') {
      this.running.delete(e.messageId);
      for (const [id, p] of this.pending) if (p.messageId === e.messageId) this.pending.delete(id);
    }
    for (const fn of this.listeners) {
      // One subscriber failing (a closed connection) must not stop the others hearing it.
      try {
        fn(e);
      } catch (err) {
        console.error('[grunt-server] app event listener failed:', err);
      }
    }
  }

  subscribe(fn: (e: AppEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Approvals requested and not yet resolved, oldest first. */
  pendingApprovals(): PendingApprovalSummary[] {
    return [...this.pending.values()];
  }

  /** Replies started and not yet finished. */
  runningTurns(): RunningTurnSummary[] {
    return [...this.running].map(([messageId, chatId]) => ({ chatId, messageId }));
  }

  /** Turns the runner's per-message events into app events. Returns the unsubscribe. */
  attach(turnRunner: TurnRunner, store: Store): () => void {
    return turnRunner.on((e) => {
      if (e.type === 'approval-request') {
        this.emit({ type: 'approval-requested', chatId: e.request.chatId, messageId: e.messageId, requestId: e.request.id, toolName: e.request.toolName });
      } else if (e.type === 'approval-resolved') {
        const chatId = this.pending.get(e.requestId)?.chatId ?? store.messages.get(e.messageId)?.chatId;
        if (chatId) this.emit({ type: 'approval-resolved', chatId, requestId: e.requestId });
      } else if (e.type === 'status' && e.status !== 'streaming') {
        const chatId = store.messages.get(e.messageId)?.chatId;
        if (chatId) this.emit({ type: 'turn-finished', chatId, messageId: e.messageId, status: e.status });
      }
    });
  }
}

/** A chat repo that announces every change on `events`. */
class EventedChatRepo implements ChatRepo {
  constructor(
    private readonly inner: ChatRepo,
    private readonly events: AppEventBus
  ) {}

  create(c: NewChat): Chat {
    const chat = this.inner.create(c);
    this.events.emit({ type: 'chat-created', chat });
    return chat;
  }

  get(id: string): Chat | null {
    return this.inner.get(id);
  }

  list(): Chat[] {
    return this.inner.list();
  }

  update(id: string, patch: Partial<Omit<Chat, 'id'>>): Chat {
    const chat = this.inner.update(id, patch);
    this.events.emit({ type: 'chat-updated', chat });
    return chat;
  }

  delete(id: string): void {
    this.inner.delete(id);
    this.events.emit({ type: 'chat-deleted', chatId: id });
  }
}

/** `store` with its chat repo announcing changes on `events`; every other repo is the same object. */
export function withChatEvents(store: Store, events: AppEventBus): Store {
  return { ...store, chats: new EventedChatRepo(store.chats, events), close: () => store.close() };
}
