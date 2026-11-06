import { randomUUID } from 'node:crypto';
import { MAX_CHAIN_DEPTH, MAX_SENDS_PER_CHAIN, MAX_TARGETS_PER_TURN, isSettled } from '@otherbench/core/domain/chat-sends.js';
import type { TurnInput, TurnResult } from '@otherbench/core/domain/turn.js';
import { workspaceUnresolvedMessage } from '@otherbench/core/domain/turn.js';
import type { ChatMessenger, ChatTargetInfo, SendOutcome, SendTarget } from '@otherbench/core/ports/chat-messenger.js';
import type { App, Chat, ChatSend, Store } from '@otherbench/core/ports/store.js';
import type { ToolContext } from '@otherbench/core/ports/tool-provider.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { MessageStatus } from '@otherbench/core/types/messages.js';
import type { Workspace, WorkspaceStatus } from '@otherbench/core/types/workspace.js';

export interface ChatSendDeps {
  store: Store;
  /** `on` hears every reply end; `cancel` is Stop's own; `runningInfo` says whether a reply is running here. */
  turnRunner: {
    on(cb: (e: { messageId: string; type: string; status?: MessageStatus }) => void): () => void;
    cancel(messageId: string, notice?: string): void;
    runningInfo(messageId: string): { chatId: string; unattended: boolean } | null;
  };
  /** `startTurn` bound to the container (turn-start.ts). */
  startTurn: (input: TurnInput) => Promise<TurnResult>;
  resolveProfile: (profileId: string) => Promise<ResolvedProfile>;
  /** A folder resolved on this machine (`workspaceResolver(container)`). */
  resolveWorkspace: (ws: Workspace | null) => WorkspaceStatus;
  /** Whether a reply is being written in the chat (`events.runningTurns()`). */
  isChatBusy: (chatId: string) => boolean;
  /** Whether the chat has the user's messages waiting to go out (`NotesService.hasWaiting`): they go first. */
  hasWaitingNotes?: (chatId: string) => boolean;
  /** A new chat in an app (routes/chats.ts `createAppChat`). */
  createAppChat: (app: App, title: string) => Chat;
  emit: (e: AppEvent) => void;
  now?: () => number;
  generateId?: () => string;
}

const NEW_CHAT_TITLE_MAX = 60;

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A new chat's title: the first line of what it was sent, cut to fit. */
function titleFrom(text: string): string {
  const first = text.trim().split(/\r?\n/)[0]!.trim();
  return first.length <= NEW_CHAT_TITLE_MAX ? first : `${first.slice(0, NEW_CHAT_TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * Chats that message each other (spec 2026-11-06-chat-to-chat-design). Keeps
 * every send in `store.chatSends`, starts the target chat's turn when it is
 * free, and when every send of a reply has settled starts the sender's next
 * turn with their replies. Local to this machine.
 */
export class ChatSendService implements ChatMessenger {
  private readonly store: Store;
  private readonly deps: ChatSendDeps;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly pending = new Set<Promise<void>>();
  private off: (() => void) | null = null;

  constructor(deps: ChatSendDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.generateId = deps.generateId ?? randomUUID;
  }

  start(): void {
    this.off = this.deps.turnRunner.on((e) => {
      if (e.type === 'status' && e.status !== undefined && e.status !== 'streaming') this.onReplyEnded(e.messageId, e.status);
    });
  }

  dispose(): void {
    this.off?.();
    this.off = null;
  }

  /** Resolves once every delivery and resume started so far has run. For tests. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  list(ctx: ToolContext): ChatTargetInfo[] {
    const self = this.store.nodes.self().id;
    const apps = new Map(this.store.apps.list().map((a) => [a.id, a.name]));
    return this.store.chats
      .list()
      .filter((c) => c.id !== ctx.chatId && c.archivedAt === null && c.runsOn === self)
      .map((c) => ({ chatId: c.id, title: c.title, app: c.appId === null ? null : (apps.get(c.appId) ?? null), busy: this.deps.isChatBusy(c.id) }));
  }

  async send(ctx: ToolContext, targets: SendTarget[]): Promise<SendOutcome> {
    const replyRow = this.store.messages.get(ctx.messageId);
    if (!replyRow || replyRow.chatId !== ctx.chatId) return { refused: 'This reply is not one OtherBench knows, so it cannot message other chats.' };
    if (replyRow.parentId !== null && this.store.messages.children(replyRow.parentId).filter((m) => m.role === 'assistant').length > 1) {
      return { refused: "Compare turns can't message other chats. Ask the user to pick one reply and continue from it." };
    }
    const { chainId, depth } = this.chainOf(ctx.messageId);
    if (depth + 1 > MAX_CHAIN_DEPTH) {
      return { refused: `This chat was itself sent work ${depth} chats deep, and chains stop at ${MAX_CHAIN_DEPTH}. Do the work here, or say in your reply what else is needed.` };
    }
    const already = this.store.chatSends.byFromMessage(ctx.messageId).length;
    if (already + targets.length > MAX_TARGETS_PER_TURN) {
      return { refused: `One reply can send to at most ${MAX_TARGETS_PER_TURN} chats${already > 0 ? ` and this one has already sent to ${already}` : ''}.` };
    }
    const chain = this.store.chatSends.byChain(chainId);
    if (chain.length + targets.length > MAX_SENDS_PER_CHAIN) {
      return { refused: `This piece of work has already sent ${chain.length} messages between chats, and the limit is ${MAX_SENDS_PER_CHAIN}. Stop here and ask the user how to go on.` };
    }
    const waitingChats = new Set(chain.filter((r) => !isSettled(r.status)).map((r) => r.fromChatId));

    // Every target is checked before anything is made, so a bad one sends nothing.
    const resolved: ({ chat: Chat } | { app: App; text: string })[] = [];
    for (const t of targets) {
      if (t.chatId !== undefined) {
        const chat = this.store.chats.get(t.chatId);
        const why = this.targetRefusal(ctx.chatId, t.chatId, chat, waitingChats);
        if (why) return { refused: why };
        resolved.push({ chat: chat! });
      } else {
        const apps = this.store.apps.list().filter((a) => sameName(a.name, t.app ?? ''));
        if (apps.length === 0) return { refused: `No app is called "${t.app}". Use list to see the apps and chats.` };
        if (apps.length > 1) return { refused: `More than one app is called "${t.app}". Send to one of their chats by chatId instead.` };
        const app = apps[0]!;
        const folder = this.deps.resolveWorkspace(app.workspace);
        if (folder.status === 'unresolved') return { refused: `The app "${app.name}" has no folder on this machine: ${workspaceUnresolvedMessage(folder)}` };
        resolved.push({ app, text: t.text });
      }
    }

    const sent: Extract<SendOutcome, { sent: unknown }>['sent'] = [];
    const appNames = new Map(this.store.apps.list().map((a) => [a.id, a.name]));
    const touched = new Set<string>([ctx.chatId]);
    for (const [i, target] of resolved.entries()) {
      const text = targets[i]!.text;
      const chat = 'chat' in target ? target.chat : this.deps.createAppChat(target.app, titleFrom(target.text));
      const row = this.store.chatSends.create({
        id: this.generateId(),
        chainId,
        depth: depth + 1,
        fromChatId: ctx.chatId,
        fromMessageId: ctx.messageId,
        toChatId: chat.id,
        createdChat: 'app' in target,
        text,
        status: 'queued',
        toReplyId: null,
        replyText: null,
        reason: null,
        resumedAs: null,
        createdAt: this.now(),
      });
      touched.add(chat.id);
      sent.push({ sendId: row.id, chatId: chat.id, title: chat.title, app: chat.appId === null ? null : (appNames.get(chat.appId) ?? null), createdChat: row.createdChat, queued: this.isBusy(chat.id) });
    }
    this.changed([...touched]);
    for (const chatId of new Set(sent.map((s) => s.chatId))) this.drain(chatId);
    return { sent };
  }

  /** Why a chat can't be sent to, or null. */
  private targetRefusal(senderId: string, chatId: string, chat: Chat | null, waitingChats: ReadonlySet<string>): string | null {
    if (chatId === senderId) return "A chat can't send work to itself.";
    if (!chat) return `There is no chat ${chatId}. Use list to see the chats you can send to.`;
    if (chat.archivedAt !== null) return `The chat "${chat.title}" is archived.`;
    if (chat.runsOn !== this.store.nodes.self().id) {
      const machine = this.store.peers.get(chat.runsOn)?.name ?? 'another machine';
      return `The chat "${chat.title}" runs on ${machine}; only chats on this machine can be sent work.`;
    }
    if (waitingChats.has(chatId)) return `The chat "${chat.title}" is waiting for this piece of work to come back, so it can't be sent more of it.`;
    return null;
  }

  /**
   * The chain a reply's sends join, and the reply's own depth in it: a reply
   * working on a send is at that send's depth; a reply that took its own sends'
   * replies (`resumedAs`) is one above them; anything else starts a chain.
   */
  private chainOf(replyId: string): { chainId: string; depth: number } {
    const serving = this.store.chatSends.byToReply(replyId)[0];
    if (serving) return { chainId: serving.chainId, depth: serving.depth };
    const resumed = this.store.chatSends.byResumedAs(replyId)[0];
    if (resumed) return { chainId: resumed.chainId, depth: resumed.depth - 1 };
    return { chainId: replyId, depth: 0 };
  }

  private isBusy(chatId: string): boolean {
    return this.deps.isChatBusy(chatId) || (this.deps.hasWaitingNotes?.(chatId) ?? false);
  }

  private changed(chatIds: string[]): void {
    this.deps.emit({ type: 'chat-sends-changed', chatIds: [...new Set(chatIds)] });
  }

  /** Starts what can start in `chatId`. */
  private drain(_chatId: string): void {}

  private onReplyEnded(_replyId: string, _status: MessageStatus): void {}

  /** The rows of every send from or to `chatId`, newest first, at most 200. */
  sendsOf(chatId: string): ChatSend[] {
    const rows = new Map<string, ChatSend>();
    for (const r of [...this.store.chatSends.byFromChat(chatId), ...this.store.chatSends.byToChat(chatId)]) rows.set(r.id, r);
    return [...rows.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  }
}
