import type { TurnRunner } from '@otherbench/core/domain/turn.js';
import type { AuditEntry, AuditRepo, Chat, ChatRepo, Grant, GrantRepo, NewChat, Store } from '@otherbench/core/ports/store.js';
import type { AppEvent, BackgroundChatSummary, ComputerSessionSummary, PendingApprovalSummary, RunningTurnSummary } from '@otherbench/core/types/events.js';

/**
 * The app-wide event bus behind `GET /api/events` (v2 plan, Task 34). Chat
 * events come from `withStoreEvents`, which wraps the store's chat repo so
 * every create, update and delete is announced whoever made it (a route,
 * auto-title, project memory), and its app, grant and audit repos the same
 * way. MCP health comes from the MCP manager (`announceMcpChanges`). Turn and approval events come from the
 * `TurnRunner` via `attach`; turn starts are emitted by the turn routes,
 * which know the chat and the new reply ids.
 *
 * It also keeps the pending approvals it has seen requested and not yet
 * resolved, each with when it was requested, and the replies started and
 * not yet finished, so a subscriber that connects later starts from the
 * right state (the `hello` event). A turn ending drops whatever it still had
 * pending: approvals end with their turn.
 *
 * And it keeps the chats that are controlling this computer (computer use),
 * with the one-line summary of their last action, from the
 * `computer-session` events `ComputerSessions` emits: the same hello.
 *
 * And how many background tasks each chat has running, from the
 * `background-tasks` events `handleBackground` emits, so the sidebar can mark
 * a chat working in the background with no reply running.
 */
export class AppEventBus {
  private readonly listeners = new Set<(e: AppEvent) => void>();
  private readonly pending = new Map<string, PendingApprovalSummary>();
  /** Replies being written, by message id. */
  private readonly running = new Map<string, string>();
  /** Chats controlling this computer, each with its last action's summary once it has acted, and the machine it was started from. */
  private readonly computer = new Map<string, { lastAction?: string; startedFrom?: string }>();
  /** Chats with background tasks running, by how many. */
  private readonly background = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  emit(e: AppEvent): void {
    if (e.type === 'approval-requested') {
      // When the card started waiting: the Needs you list's order (`needsYouSince`), told to every window and in the hello.
      if (e.at === undefined) e = { ...e, at: this.now() };
      this.pending.set(e.requestId, { chatId: e.chatId, messageId: e.messageId, requestId: e.requestId, toolName: e.toolName, ...(e.kind ? { kind: e.kind } : {}), at: e.at });
    } else if (e.type === 'approval-resolved') {
      this.pending.delete(e.requestId);
    } else if (e.type === 'turn-started') {
      for (const messageId of e.messageIds) this.running.set(messageId, e.chatId);
    } else if (e.type === 'turn-finished') {
      this.running.delete(e.messageId);
      for (const [id, p] of this.pending) if (p.messageId === e.messageId) this.pending.delete(id);
    } else if (e.type === 'computer-session') {
      if (e.active) {
        const before = this.computer.get(e.chatId);
        const lastAction = e.lastAction ?? before?.lastAction;
        const startedFrom = e.startedFrom ?? before?.startedFrom;
        this.computer.set(e.chatId, { ...(lastAction === undefined ? {} : { lastAction }), ...(startedFrom === undefined ? {} : { startedFrom }) });
      } else this.computer.delete(e.chatId);
    } else if (e.type === 'background-tasks') {
      if (e.count > 0) this.background.set(e.chatId, e.count);
      else this.background.delete(e.chatId);
    }
    for (const fn of this.listeners) {
      // One subscriber failing (a closed connection) must not stop the others hearing it.
      try {
        fn(e);
      } catch (err) {
        console.error('[otherbench-server] app event listener failed:', err);
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

  /** Chats controlling this computer, with their last action. */
  computerSessions(): ComputerSessionSummary[] {
    return [...this.computer].map(([chatId, session]) => ({ chatId, ...session }));
  }

  /** Chats with background tasks running. */
  backgroundChats(): BackgroundChatSummary[] {
    return [...this.background].map(([chatId, count]) => ({ chatId, count }));
  }

  /** Turns the runner's per-message events into app events. Returns the unsubscribe. */
  attach(turnRunner: TurnRunner, store: Store): () => void {
    return turnRunner.on((e) => {
      if (e.type === 'approval-request') {
        this.emit({ type: 'approval-requested', chatId: e.request.chatId, messageId: e.messageId, requestId: e.request.id, toolName: e.request.toolName });
      } else if (e.type === 'approval-resolved') {
        const chatId = this.pending.get(e.requestId)?.chatId ?? store.messages.get(e.messageId)?.chatId;
        if (chatId) this.emit({ type: 'approval-resolved', chatId, requestId: e.requestId });
      } else if (e.type === 'ask-request') {
        this.emit({ type: 'approval-requested', chatId: e.ask.chatId, messageId: e.messageId, requestId: e.ask.id, toolName: e.ask.toolName, kind: e.ask.kind });
      } else if (e.type === 'ask-resolved') {
        const chatId = this.pending.get(e.askId)?.chatId ?? store.messages.get(e.messageId)?.chatId;
        if (chatId) this.emit({ type: 'approval-resolved', chatId, requestId: e.askId });
      } else if (e.type === 'status' && e.status !== 'streaming') {
        const chatId = store.messages.get(e.messageId)?.chatId;
        if (chatId) this.emit({ type: 'turn-finished', chatId, messageId: e.messageId, status: e.status });
      }
    });
  }
}

/**
 * Marks a chat `unread` when a reply there finishes or fails, so the sidebar
 * shows it's ready; a reply the user stopped isn't marked. Covers replies run
 * on a paired machine too, whose `turn-finished` the forwarding emits here.
 * `store` should be the evented one, so the change reaches every window. It
 * leaves `updatedAt` alone. A chat already unread is announced anyway: the
 * sidebar reads the finished reply from the chat. Returns the unsubscribe.
 */
export function markUnreadOnFinish(events: AppEventBus, store: Store): () => void {
  return events.subscribe((e) => {
    if (e.type !== 'turn-finished' || (e.status !== 'complete' && e.status !== 'error')) return;
    const chat = store.chats.get(e.chatId);
    if (chat?.unread) events.emit({ type: 'chat-updated', chat });
    else if (chat) store.chats.update(e.chatId, { unread: true });
  });
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

/** A repo that says `apps-changed` on `events` after each write. `AppRepo` and `AppFolderRepo` are both this shape. */
class EventedAppsRepo<Row, New, Patch> {
  constructor(
    private readonly inner: { create(row: New): Row; get(id: string): Row | null; list(): Row[]; update(id: string, patch: Patch): Row; delete(id: string): void },
    private readonly events: AppEventBus
  ) {}

  create(row: New): Row {
    const created = this.inner.create(row);
    this.events.emit({ type: 'apps-changed' });
    return created;
  }

  get(id: string): Row | null {
    return this.inner.get(id);
  }

  list(): Row[] {
    return this.inner.list();
  }

  update(id: string, patch: Patch): Row {
    const updated = this.inner.update(id, patch);
    this.events.emit({ type: 'apps-changed' });
    return updated;
  }

  delete(id: string): void {
    this.inner.delete(id);
    this.events.emit({ type: 'apps-changed' });
  }
}

/**
 * A grant repo that says `grants-changed` after each write, with the grant's
 * chat (null for an "always" grant), so the Inspector re-reads its grants.
 * Covers the broker's grants and its use of a "once" grant as well as Revoke.
 */
class EventedGrantRepo implements GrantRepo {
  constructor(
    private readonly inner: GrantRepo,
    private readonly events: AppEventBus
  ) {}

  create(g: Grant): Grant {
    const grant = this.inner.create(g);
    this.events.emit({ type: 'grants-changed', chatId: grant.chatId });
    return grant;
  }

  get(id: string): Grant | null {
    return this.inner.get(id);
  }

  list(chatId?: string): Grant[] {
    return this.inner.list(chatId);
  }

  update(id: string, patch: Partial<Omit<Grant, 'id'>>): Grant {
    const before = this.inner.get(id);
    const grant = this.inner.update(id, patch);
    this.events.emit({ type: 'grants-changed', chatId: grant.chatId });
    // Moved to another chat (or to "always"): the one it left re-reads too.
    if (before && before.chatId !== grant.chatId) this.events.emit({ type: 'grants-changed', chatId: before.chatId });
    return grant;
  }

  delete(id: string): void {
    const grant = this.inner.get(id);
    this.inner.delete(id);
    if (grant) this.events.emit({ type: 'grants-changed', chatId: grant.chatId });
  }
}

/** An audit repo that says `audit-changed` with the entry's chat after each write, so the Inspector re-reads the trail. */
class EventedAuditRepo implements AuditRepo {
  constructor(
    private readonly inner: AuditRepo,
    private readonly events: AppEventBus
  ) {}

  create(a: Omit<AuditEntry, 'createdAt'> & { createdAt?: number }): AuditEntry {
    const entry = this.inner.create(a);
    this.events.emit({ type: 'audit-changed', chatId: entry.chatId });
    return entry;
  }

  get(id: string): AuditEntry | null {
    return this.inner.get(id);
  }

  list(chatId: string): AuditEntry[] {
    return this.inner.list(chatId);
  }

  update(id: string, patch: Partial<Omit<AuditEntry, 'id'>>): AuditEntry {
    const entry = this.inner.update(id, patch);
    this.events.emit({ type: 'audit-changed', chatId: entry.chatId });
    return entry;
  }

  delete(id: string): void {
    const entry = this.inner.get(id);
    this.inner.delete(id);
    if (entry) this.events.emit({ type: 'audit-changed', chatId: entry.chatId });
  }
}

/**
 * Says `mcp-changed` whenever the MCP manager's health may have changed (a
 * status, a tool list, a sign-in, a server added, edited or removed), so the
 * Inspector and Settings > MCP servers re-read it. Returns the unsubscribe.
 */
export function announceMcpChanges(events: AppEventBus, mcp: { onChange(listener: (serverId: string | null) => void): () => void }): () => void {
  return mcp.onChange((serverId) => events.emit({ type: 'mcp-changed', serverId }));
}

/** `store` with its chat, app, app folder, grant and audit repos announcing changes on `events`; every other repo is the same object. */
export function withStoreEvents(store: Store, events: AppEventBus): Store {
  return {
    ...store,
    chats: new EventedChatRepo(store.chats, events),
    apps: new EventedAppsRepo(store.apps, events),
    appFolders: new EventedAppsRepo(store.appFolders, events),
    grants: new EventedGrantRepo(store.grants, events),
    audit: new EventedAuditRepo(store.audit, events),
    transaction: (fn) => store.transaction(fn),
    close: () => store.close(),
  };
}
