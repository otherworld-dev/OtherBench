import { randomUUID } from 'node:crypto';
import { MAX_CHAIN_DEPTH, MAX_SENDS_PER_CHAIN, MAX_TARGETS_PER_TURN, cutReply, deliveredText, isSettled, repliesText, type ChatSendStatus } from '@otherbench/core/domain/chat-sends.js';
import type { TurnInput, TurnResult } from '@otherbench/core/domain/turn.js';
import { workspaceUnresolvedMessage } from '@otherbench/core/domain/turn.js';
import type { ChatMessenger, ChatTargetInfo, SendOutcome, SendTarget } from '@otherbench/core/ports/chat-messenger.js';
import type { App, Chat, ChatSend, Store } from '@otherbench/core/ports/store.js';
import type { ToolContext } from '@otherbench/core/ports/tool-provider.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { MessageStatus, Part } from '@otherbench/core/types/messages.js';
import type { Workspace, WorkspaceStatus } from '@otherbench/core/types/workspace.js';
import { chatTip } from '../routes/chats.js';
import { lineAfter } from '../turn-start.js';

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

/** `resumedAs` for a group that was closed without a turn (its sender deleted, cleared, or stopped from the card). */
export const NO_RESUME = 'none';

export const STOPPED_FROM_CARD = 'Stopped from the send card.';
export const SENDER_STOPPED = 'The chat that sent this was stopped.';
/** What a chat is told when the work it passed on was stopped from that chat's own card. */
const PASSED_ON_STOPPED = 'The chat it was sent to stopped the work it had passed on.';
/** Stops that mean "don't carry on": a group stopped for one of these closes without resuming its sender. */
const NO_RESUME_REASONS: ReadonlySet<string> = new Set([STOPPED_FROM_CARD, SENDER_STOPPED]);

/** What a reply ended by saying: its text after its last tool call, the part a sender wants back. */
function finalText(parts: readonly Part[]): string {
  let start = 0;
  parts.forEach((p, i) => {
    if (p.type === 'tool-call' || p.type === 'tool-result' || p.type === 'subagent') start = i + 1;
  });
  return parts
    .slice(start)
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
    .trim();
}

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
  /** Chats a turn is being started in by this service right now: one at a time per chat. */
  private readonly starting = new Set<string>();
  /** Sending replies whose group has all come back, waiting for their chat to be free. */
  private readonly due = new Set<string>();
  private off: (() => void) | null = null;
  /** Set by dispose: a follow-up queued just before (a reply that ended as the server closed) then does nothing. */
  private disposed = false;

  constructor(deps: ChatSendDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.generateId = deps.generateId ?? randomUUID;
  }

  /**
   * Listens for replies ending, then picks up where a previous process left off: a send whose reply isn't
   * running here any more ended as that reply is stored (a restart already reconciled it as an error), and
   * anything still queued gets another look.
   */
  start(): void {
    this.off = this.deps.turnRunner.on((e) => {
      if (e.type === 'status' && e.status !== undefined && e.status !== 'streaming') this.onReplyEnded(e.messageId, e.status);
    });
    for (const row of this.store.chatSends.unsettled()) {
      if (row.status !== 'running' || row.toReplyId === null || this.deps.turnRunner.runningInfo(row.toReplyId) !== null) continue;
      const stored = this.store.messages.get(row.toReplyId)?.status;
      this.onReplyEnded(row.toReplyId, stored === undefined || stored === 'streaming' ? 'error' : stored);
    }
    this.drainAll();
  }

  /** Stop on the send card of reply `fromMessageId`: everything it started stops, down the chain, and it doesn't resume. */
  stop(fromMessageId: string): void {
    this.stopTree(fromMessageId, STOPPED_FROM_CARD);
    this.maybeResume(fromMessageId);
  }

  /** The chats with sends of theirs still out, or back and waiting to resume them: the "waiting on chats" status. */
  waitingChatIds(): string[] {
    const ids = new Set(this.store.chatSends.unsettled().map((r) => r.fromChatId));
    for (const m of this.due) {
      const chatId = this.store.chatSends.byFromMessage(m)[0]?.fromChatId;
      if (chatId !== undefined) ids.add(chatId);
    }
    return [...ids];
  }

  /**
   * Stops every unsettled send of reply `fromMessageId` with `reason`: a queued one settles now, a running one has
   * its reply stopped (it settles when that reply ends) and its own sends stopped in turn. A send whose reply
   * already ended, waiting on sends of its own, closes once those have.
   */
  private stopTree(fromMessageId: string, reason: string): void {
    for (const row of this.store.chatSends.byFromMessage(fromMessageId).filter((r) => !isSettled(r.status))) {
      if (row.status === 'queued') {
        this.settle(row.id, 'stopped', null, reason);
        continue;
      }
      if (row.reason === null) this.store.chatSends.update(row.id, { reason });
      if (row.toReplyId === null) continue;
      if (this.deps.turnRunner.runningInfo(row.toReplyId) !== null) this.deps.turnRunner.cancel(row.toReplyId);
      this.stopTree(row.toReplyId, reason);
      this.maybeResume(row.toReplyId);
    }
  }

  dispose(): void {
    this.disposed = true;
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

  /** Keeps a delivery or resume in `pending` until it settles, for `idle()`. */
  private track(work: Promise<void>): void {
    const tracked = work.catch((err: unknown) => console.error('[ChatSendService]', err)).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Every chat with a message waiting to go out gets another look. Called whenever a reply ends anywhere. */
  private drainAll(): void {
    for (const chatId of new Set(this.store.chatSends.unsettled().filter((r) => r.status === 'queued').map((r) => r.toChatId))) this.drain(chatId);
  }

  /**
   * Starts the oldest message waiting for `chatId`, if the chat is free: no reply running, none of the user's
   * own messages waiting, and nothing else being started there by this service. A chat that has gone fails
   * everything waiting for it.
   */
  private drain(chatId: string): void {
    if (this.starting.has(chatId)) return;
    const queued = this.store.chatSends.byToChat(chatId).filter((r) => r.status === 'queued');
    if (queued.length === 0) return;
    const chat = this.store.chats.get(chatId);
    if (!chat) {
      for (const row of queued) this.settle(row.id, 'failed', null, 'The chat was deleted before the message could go out.');
      return;
    }
    if (this.isBusy(chatId)) return;
    this.starting.add(chatId);
    this.track(this.deliver(queued[0]!, chat).finally(() => this.starting.delete(chatId)));
  }

  /** One message into its chat as a new turn, marked as from the chat that sent it. A failure settles it as failed. */
  private async deliver(row: ChatSend, chat: Chat): Promise<void> {
    let replyId: string;
    try {
      const from = this.store.chats.get(row.fromChatId);
      const fromTitle = from?.title ?? 'a chat that has since been deleted';
      const appName = from?.appId ? (this.store.apps.get(from.appId)?.name ?? null) : null;
      const folder = this.deps.resolveWorkspace(chat.workspace);
      if (folder.status === 'unresolved') throw new Error(workspaceUnresolvedMessage(folder));
      const profile = await this.deps.resolveProfile(chat.profileId);
      const now = this.store.chats.get(chat.id);
      if (!now) throw new Error('The chat was deleted before the message could go out.');
      const parentId = chatTip(this.store, now.id, now.headMessageId);
      // Stopped (or settled some other way) while the profile resolved: nothing goes out.
      if (this.store.chatSends.get(row.id)?.status !== 'queued') return;
      const result = await this.deps.startTurn({
        chatId: now.id,
        parentId,
        userParts: [
          { type: 'chat-link', kind: 'from', chats: [{ chatId: row.fromChatId, title: fromTitle }], sendIds: [row.id] },
          { type: 'text', text: deliveredText({ title: fromTitle, chatId: row.fromChatId, appName }, row.text) },
        ],
        profiles: [profile],
      });
      replyId = result.assistantMessageIds[0]!;
    } catch (err) {
      this.settle(row.id, 'failed', null, err instanceof Error ? err.message : String(err));
      return;
    }
    this.store.chatSends.update(row.id, { status: 'running', toReplyId: replyId });
    this.changed([row.fromChatId, row.toChatId]);
    // A reply that ended before the row named it (a fast model) is ended here.
    const status = this.store.messages.get(replyId)?.status;
    if (status !== undefined && status !== 'streaming') this.onReplyEnded(replyId, status);
  }

  /** Marks one send settled, once: a row already settled is left as it is. */
  private settle(id: string, status: ChatSendStatus, text: string | null, reason: string | null): void {
    const row = this.store.chatSends.get(id);
    if (!row || isSettled(row.status)) return;
    this.store.chatSends.update(id, { status, replyText: text, reason, finishedAt: this.now() });
    this.changed([row.fromChatId, row.toChatId]);
  }

  /**
   * A reply ended, anywhere. If it sent work and that work hasn't come back yet, it is waiting, and the rows it
   * works on for another chat stay open. Otherwise those rows settle with what it said (or how it failed), and each
   * one's sender may now be due to resume. Safe to hear twice: a settled row and a resumed group are left alone.
   */
  private onReplyEnded(replyId: string, status: MessageStatus): void {
    const out = this.store.chatSends.byFromMessage(replyId);
    if (status !== 'complete' && out.some((r) => !isSettled(r.status))) this.stopTree(replyId, SENDER_STOPPED);
    if (status === 'complete' && out.some((r) => r.resumedAs === null)) {
      // Its sends' replies may already all be in (a fast target): then it is due now that it has ended.
      this.maybeResume(replyId);
    } else {
      const serving = this.store.chatSends.byToReply(replyId).filter((r) => !isSettled(r.status));
      if (serving.length > 0) {
        const message = this.store.messages.get(replyId);
        const text = message ? finalText(message.parts) : '';
        for (const row of serving) {
          if (status === 'complete') this.settle(row.id, 'replied', cutReply(text), null);
          else if (status === 'cancelled') this.settle(row.id, 'stopped', null, row.reason ?? 'The reply was stopped before it finished.');
          else this.settle(row.id, 'failed', text === '' ? null : cutReply(text), message?.error?.message ?? 'The reply ended with an error.');
          this.maybeResume(row.fromMessageId);
        }
      }
    }
    // After the notes service and the app events have heard it, so a chat's own waiting messages go first.
    setImmediate(() => {
      if (this.disposed) return;
      this.drainAll();
      this.resumeDue();
    });
  }

  /**
   * Whether the sends of reply `fromMessageId` have all settled and not been resumed yet: then the sender is due,
   * unless it can't take the replies any more (deleted, or cleared after it sent), when the group is closed
   * without a turn and whatever that reply was working on for another chat ends too.
   */
  private maybeResume(fromMessageId: string): void {
    const group = this.store.chatSends.byFromMessage(fromMessageId);
    if (group.length === 0 || group.some((r) => !isSettled(r.status) || r.resumedAs !== null)) return;
    // The sending reply itself must have ended first: its chat isn't free until then anyway.
    if (this.store.messages.get(fromMessageId)?.status === 'streaming') return;
    if (group.every((r) => r.status === 'stopped' && r.reason !== null && NO_RESUME_REASONS.has(r.reason))) {
      this.close(fromMessageId, 'stopped', PASSED_ON_STOPPED);
      return;
    }
    const sender = this.store.chats.get(group[0]!.fromChatId);
    if (!sender) {
      this.close(fromMessageId, 'dropped', 'The chat that sent this was deleted.');
      return;
    }
    if (lineAfter({ store: this.store }, sender.headMessageId, fromMessageId)) {
      this.close(fromMessageId, 'dropped', 'The chat that sent this was cleared (/clear or /compact) before the replies came back.');
      return;
    }
    this.due.add(fromMessageId);
    this.resumeDue();
  }

  /** Marks a group handled with no resume, and ends whatever its sending reply was working on for another chat. */
  private close(fromMessageId: string, status: ChatSendStatus, reason: string): void {
    const group = this.store.chatSends.byFromMessage(fromMessageId);
    for (const row of group) this.store.chatSends.update(row.id, { resumedAs: NO_RESUME });
    if (group[0]) this.changed([group[0].fromChatId]);
    this.due.delete(fromMessageId);
    for (const row of this.store.chatSends.byToReply(fromMessageId).filter((r) => !isSettled(r.status))) {
      // A row Stop already marked keeps its own reason, so a stop from the card above stays a stop from the card.
      this.settle(row.id, status, null, row.reason ?? reason);
      this.maybeResume(row.fromMessageId);
    }
  }

  /** Starts every due resume whose chat is free. */
  private resumeDue(): void {
    for (const fromMessageId of [...this.due]) {
      const chatId = this.store.chatSends.byFromMessage(fromMessageId)[0]?.fromChatId;
      if (chatId === undefined || this.starting.has(chatId) || this.isBusy(chatId)) continue;
      this.due.delete(fromMessageId);
      this.starting.add(chatId);
      this.track(this.resume(fromMessageId, chatId).finally(() => this.starting.delete(chatId)));
    }
  }

  /**
   * The sender's next turn: one user message carrying every reply of the group, after the end of its thread (or
   * after the sending reply, if the thread ends where no turn can follow). It runs as the profile that sent them.
   * The rows the sending reply works on for another chat move to the new reply, so they settle when it ends.
   */
  private async resume(fromMessageId: string, chatId: string): Promise<void> {
    const group = this.store.chatSends.byFromMessage(fromMessageId);
    if (group.some((r) => !isSettled(r.status) || r.resumedAs !== null)) return;
    const chat = this.store.chats.get(chatId);
    if (!chat || lineAfter({ store: this.store }, chat.headMessageId, fromMessageId)) {
      this.maybeResume(fromMessageId);
      return;
    }
    let replyId: string;
    try {
      const sentAs = this.store.messages.get(fromMessageId)?.producedBy?.profileId ?? chat.profileId;
      const profile = await this.deps.resolveProfile(sentAs).catch(() => this.deps.resolveProfile(chat.profileId));
      let parentId: string | null;
      try {
        parentId = chatTip(this.store, chat.id, this.store.chats.get(chat.id)?.headMessageId ?? null);
      } catch {
        parentId = fromMessageId;
      }
      const rows = group.map((r) => ({ row: r, title: this.store.chats.get(r.toChatId)?.title ?? 'a chat that has since been deleted' }));
      const result = await this.deps.startTurn({
        chatId: chat.id,
        parentId,
        userParts: [
          { type: 'chat-link', kind: 'replies', chats: rows.map(({ row, title }) => ({ chatId: row.toChatId, title, status: row.status })), sendIds: group.map((r) => r.id) },
          { type: 'text', text: repliesText(rows.map(({ row, title }) => ({ title, chatId: row.toChatId, status: row.status, text: row.replyText, reason: row.reason }))) },
        ],
        profiles: [profile],
      });
      replyId = result.assistantMessageIds[0]!;
    } catch (err) {
      this.close(fromMessageId, 'failed', `The chat that sent this couldn't carry on: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const row of group) this.store.chatSends.update(row.id, { resumedAs: replyId });
    for (const row of this.store.chatSends.byToReply(fromMessageId).filter((r) => !isSettled(r.status))) this.store.chatSends.update(row.id, { toReplyId: replyId });
    this.changed([chatId, ...group.map((r) => r.toChatId)]);
    const status = this.store.messages.get(replyId)?.status;
    if (status !== undefined && status !== 'streaming') this.onReplyEnded(replyId, status);
  }

  /** The rows of every send from or to `chatId`, newest first, at most 200. */
  sendsOf(chatId: string): ChatSend[] {
    const rows = new Map<string, ChatSend>();
    for (const r of [...this.store.chatSends.byFromChat(chatId), ...this.store.chatSends.byToChat(chatId)]) rows.set(r.id, r);
    return [...rows.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  }
}
