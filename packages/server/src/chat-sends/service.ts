import { randomUUID } from 'node:crypto';
import { MAX_CHAIN_DEPTH, MAX_SENDS_PER_CHAIN, MAX_TARGETS_PER_TURN, cutReply, deliveredText, isSettled, repliesText, type ChatSendStatus } from '@otherbench/core/domain/chat-sends.js';
import { isCompareSet } from '@otherbench/core/domain/tree.js';
import type { TurnInput, TurnResult } from '@otherbench/core/domain/turn.js';
import { workspaceUnresolvedMessage } from '@otherbench/core/domain/turn.js';
import type { AppTargetInfo, ChatMessenger, ChatTargetInfo, SendOutcome, SendTarget } from '@otherbench/core/ports/chat-messenger.js';
import type { App, Chat, ChatSend, ChatSendView, Store } from '@otherbench/core/ports/store.js';
import type { ToolContext } from '@otherbench/core/ports/tool-provider.js';
import type { ResolvedProfile } from '@otherbench/core/types/config.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { MessageStatus, Part } from '@otherbench/core/types/messages.js';
import type { Workspace, WorkspaceStatus } from '@otherbench/core/types/workspace.js';
import { chatTip } from '../routes/chats.js';
import { lineAfter } from '../turn-start.js';
import { CANCELLED_BY_USER, notHereReason, sendsOffReason, unreachableReason, type ChatSendRemote, type Handover, type HandoverAnswer, type Outcome } from './remote-port.js';

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
  /** A folder resolved on this machine, or on paired machine `on` (`workspaceResolver(container)`). */
  resolveWorkspace: (ws: Workspace | null, on?: string) => WorkspaceStatus;
  /** Whether a reply is being written in the chat (`events.runningTurns()`). */
  isChatBusy: (chatId: string) => boolean;
  /** Whether the chat has the user's messages waiting to go out (`NotesService.hasWaiting`): they go first. */
  hasWaitingNotes?: (chatId: string) => boolean;
  /** A new chat in an app (routes/chats.ts `createAppChat`), under `id` when given. */
  createAppChat: (app: App, title: string, id?: string) => Chat;
  /**
   * Paired machines (spec 2026-11-13-chat-sends-across-machines-design): sends to chats that run there are handed
   * over and their outcomes come back. Absent, only chats on this machine can be sent to.
   */
  remote?: ChatSendRemote;
  emit: (e: AppEvent) => void;
  now?: () => number;
  generateId?: () => string;
  /**
   * How often (ms) waiting work gets another look even when no reply ends: a chat can come free without one
   * (the user's waiting notes handed back, say). Default 5000.
   */
  retryMs?: number;
}

const NEW_CHAT_TITLE_MAX = 60;

/** `resumedAs` for a group that was closed without a turn (its sender deleted, cleared, or stopped from the card). */
export const NO_RESUME = 'none';

export const STOPPED_FROM_CARD = 'Stopped from the send card.';
export const SENDER_STOPPED = 'The chat that sent this was stopped.';
/** What a chat is told when the work it passed on was stopped from that chat's own card. */
const PASSED_ON_STOPPED = 'The chat it was sent to stopped the work it had passed on.';
/** Stops that mean "don't carry on": a send stopped for one of these never comes back as "failed". */
const NO_RESUME_REASONS: ReadonlySet<string> = new Set([STOPPED_FROM_CARD, SENDER_STOPPED]);
/** What a chat is told when the chat it sent to can't take its own replies any more, from the sender's side. */
const TARGET_DELETED = 'The chat it was sent to was deleted before it finished.';
const TARGET_CLEARED = 'The chat it was sent to was cleared (/clear or /compact) before it finished.';

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
 * The machine a new chat in `app` runs on (spec 2026-11-13-chat-sends-across-machines-design): the one its folder is
 * bound to; for a location, this machine if it resolves here, else the first paired machine where it does; with no
 * folder, this machine. Null when there is nowhere it could run.
 */
export function appMachine(app: App, self: string, resolve: (ws: Workspace | null, on?: string) => WorkspaceStatus, peers: readonly string[]): string | null {
  const ws = app.workspace;
  if (ws === null) return self;
  if (ws.kind === 'machine' && ws.nodeId !== self) return ws.nodeId;
  if (resolve(ws, self).status === 'ok') return self;
  if (ws.kind === 'machine') return null;
  return peers.find((p) => resolve(ws, p).status === 'ok') ?? null;
}

/**
 * Chats that message each other (spec 2026-11-06-chat-to-chat-design). Keeps
 * every send in `store.chatSends`, starts the target chat's turn when it is
 * free, and when every send of a reply has settled starts the sender's next
 * turn with their replies. A send to a chat on a paired machine is handed to that machine, which keeps its own row
 * under the same id and reports the outcome back (spec 2026-11-13-chat-sends-across-machines-design); handovers,
 * stops and reports that didn't get through are tried again on every tick.
 */
export class ChatSendService implements ChatMessenger {
  private readonly store: Store;
  private readonly deps: ChatSendDeps;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly pending = new Set<Promise<void>>();
  /** Chats a turn is being started in by this service right now: one at a time per chat. */
  private readonly starting = new Set<string>();
  /** Sends being handed to, or a stop or outcome being told to, a paired machine right now: one call per send at a time. */
  private readonly handing = new Set<string>();
  private readonly telling = new Set<string>();
  /** Sending replies whose group has all come back, waiting for their chat to be free. */
  private readonly due = new Set<string>();
  private off: (() => void) | null = null;
  /** Set by dispose: a follow-up queued just before (a reply that ended as the server closed) then does nothing. */
  private disposed = false;
  private retry: ReturnType<typeof setInterval> | null = null;

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
    for (const { id } of this.store.chatSends.unsettled()) {
      // Read again: handling an earlier row may have settled this one (a chain's lower rows, stopped from above).
      const row = this.store.chatSends.get(id);
      // A row handed to a paired machine runs there: its outcome comes back from it.
      if (!row || row.status !== 'running' || row.toNode !== null || row.toReplyId === null || this.deps.turnRunner.runningInfo(row.toReplyId) !== null) continue;
      const stored = this.store.messages.get(row.toReplyId)?.status;
      this.onReplyEnded(row.toReplyId, stored === undefined || stored === 'streaming' ? 'error' : stored);
    }
    // Groups that had all come back but not yet gone to their sender (it was busy) when the server stopped.
    for (const fromMessageId of new Set(this.store.chatSends.unresumed().map((r) => r.fromMessageId))) this.maybeResume(fromMessageId);
    this.drainAll();
    this.remoteAll();
    this.retry = setInterval(() => this.tick(), this.deps.retryMs ?? 5000);
    this.retry.unref?.();
  }

  /** Another look at everything waiting: chats come free, senders resume, and paired machines are tried again. */
  tick(): void {
    if (this.disposed) return;
    this.drainAll();
    this.resumeDue();
    this.remoteAll();
  }

  /** Stop on the send card of reply `fromMessageId`: everything it started stops, down the chain, and it doesn't resume. */
  stop(fromMessageId: string): void {
    this.stopTree(fromMessageId, STOPPED_FROM_CARD);
    // Closed now, whatever already came back: the sender doesn't carry on. A chat above it is told its work was stopped.
    this.closeGroup(fromMessageId);
    this.settleServed(fromMessageId, 'stopped', PASSED_ON_STOPPED);
  }

  /** The chats with sends of theirs still out, or back and waiting to resume them: the "waiting on chats" status. */
  waitingChatIds(): string[] {
    // A row a paired machine handed here waits for nothing on this machine: its sender is there.
    const ids = new Set(this.store.chatSends.unsettled().filter((r) => r.fromNode === null).map((r) => r.fromChatId));
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
    for (const row of this.store.chatSends.byFromMessage(fromMessageId).filter((r) => !isSettled(r.status))) this.stopRow(row, reason);
  }

  /** Stops one unsettled send (see `stopTree`). One running on a paired machine settles now, and that machine is told. */
  private stopRow(row: ChatSend, reason: string): void {
    if (row.status === 'queued') {
      this.settle(row.id, 'stopped', null, reason);
      return;
    }
    if (row.toNode !== null) {
      // Never waits on the other machine: settled now, and told until it takes it (`remoteAll`).
      this.store.chatSends.update(row.id, { stopPending: reason });
      this.settle(row.id, 'stopped', null, reason);
      this.tellStop(row.id);
      return;
    }
    if (row.reason === null) this.store.chatSends.update(row.id, { reason });
    if (row.toReplyId === null) return;
    this.stopTree(row.toReplyId, reason);
    // Nothing below resumes either, even where some of its sends had already replied.
    this.closeGroup(row.toReplyId);
    if (this.deps.turnRunner.runningInfo(row.toReplyId) !== null) {
      // Its reply settles the row as it ends (`onReplyEnded`), keeping this reason.
      this.deps.turnRunner.cancel(row.toReplyId);
    } else {
      // Its reply had already ended, waiting on sends of its own: nothing else will settle the row.
      this.settle(row.id, 'stopped', null, reason);
    }
  }

  /** The chats with a send held for a machine that is off or busy, that the user hasn't chosen Wait for: Needs you. */
  heldChatIds(): string[] {
    return [...new Set(this.heldRows().filter((r) => !r.heldSeen).map((r) => r.fromChatId))];
  }

  /** Since when each of those chats has waited on the user, for the Needs you order. */
  heldSince(): Record<string, number> {
    const since: Record<string, number> = {};
    for (const r of this.heldRows()) if (!r.heldSeen) since[r.fromChatId] = Math.min(since[r.fromChatId] ?? r.createdAt, r.createdAt);
    return since;
  }

  private heldRows(): ChatSend[] {
    return this.store.chatSends.unsettled().filter((r) => r.fromNode === null && r.toNode !== null && r.status === 'queued' && r.heldReason !== null);
  }

  /** Marks a group of sends handled with no resume (`resumedAs: 'none'`), and takes it off the due list. */
  private closeGroup(fromMessageId: string): void {
    const group = this.store.chatSends.byFromMessage(fromMessageId);
    for (const row of group) if (row.resumedAs === null) this.store.chatSends.update(row.id, { resumedAs: NO_RESUME });
    if (group[0]) this.changed([group[0].fromChatId]);
    this.due.delete(fromMessageId);
  }

  /** Settles the sends reply `replyId` was working on for other chats (a row Stop marked keeps its own reason), whose senders may then be due. */
  private settleServed(replyId: string, status: ChatSendStatus, reason: string): void {
    for (const row of this.store.chatSends.byToReply(replyId).filter((r) => !isSettled(r.status))) {
      this.settle(row.id, status, null, row.reason ?? reason);
      this.maybeResume(row.fromMessageId);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry !== null) clearInterval(this.retry);
    this.retry = null;
    this.off?.();
    this.off = null;
  }

  /** Resolves once every delivery and resume started so far has run. For tests. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  async list(ctx: ToolContext): Promise<{ chats: ChatTargetInfo[]; apps: AppTargetInfo[] }> {
    const self = this.selfId();
    const apps = new Map(this.store.apps.list().map((a) => [a.id, a.name]));
    const chats = this.store.chats
      .list()
      .filter((c) => c.id !== ctx.chatId && c.archivedAt === null && this.reachableMachine(c.runsOn))
      .map((c) => ({
        chatId: c.id,
        title: c.title,
        app: c.appId === null ? null : (apps.get(c.appId) ?? null),
        busy: c.runsOn === self ? this.deps.isChatBusy(c.id) : (this.deps.remote?.activeChats(c.runsOn).includes(c.id) ?? false),
        machine: this.machineName(c.runsOn),
        acceptsSends: this.acceptsSends(c.runsOn),
      }));
    const appTargets = this.store.apps.list().flatMap((a): AppTargetInfo[] => {
      const machine = this.appMachineOf(a);
      return machine === null || !this.reachableMachine(machine) ? [] : [{ name: a.name, machine: this.machineName(machine), acceptsSends: this.acceptsSends(machine) }];
    });
    return { chats, apps: appTargets };
  }

  private selfId(): string {
    return this.store.nodes.self().id;
  }

  /** This machine, or a paired one while this service can hand work to paired machines. */
  private reachableMachine(nodeId: string): boolean {
    return nodeId === this.selfId() || (this.deps.remote !== undefined && this.store.peers.get(nodeId) !== null);
  }

  private machineName(nodeId: string): string {
    if (nodeId === this.selfId()) return this.store.nodes.self().name;
    return this.deps.remote?.machineName(nodeId) ?? this.store.peers.get(nodeId)?.name ?? 'another machine';
  }

  /** Whether `nodeId` takes sends from here: false it said no, null it hasn't said or can't be reached now. */
  private acceptsSends(nodeId: string): boolean | null {
    if (nodeId === this.selfId()) return true;
    const state = this.deps.remote?.state(nodeId);
    return state === 'ok' ? true : state === 'off' ? false : null;
  }

  private appMachineOf(app: App): string | null {
    const peers = this.deps.remote ? this.store.peers.list().map((p) => p.nodeId) : [];
    return appMachine(app, this.selfId(), this.deps.resolveWorkspace, peers);
  }

  /** The sends a chain has, counting those made before it reached this machine (`chainBase`). */
  private chainCount(chainId: string): number {
    const rows = this.store.chatSends.byChain(chainId);
    return rows.length + Math.max(0, ...rows.map((r) => r.chainBase));
  }

  async send(ctx: ToolContext, targets: SendTarget[]): Promise<SendOutcome> {
    const replyRow = this.store.messages.get(ctx.messageId);
    if (!replyRow || replyRow.chatId !== ctx.chatId) return { refused: 'This reply is not one OtherBench knows, so it cannot message other chats.' };
    // A regenerated reply is a sibling too, but not a compare (`isCompareSet`).
    if (replyRow.parentId !== null && isCompareSet(this.store.messages.children(replyRow.parentId))) {
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
    const sentInChain = this.chainCount(chainId);
    if (sentInChain + targets.length > MAX_SENDS_PER_CHAIN) {
      return { refused: `This piece of work has already sent ${sentInChain} messages between chats, and the limit is ${MAX_SENDS_PER_CHAIN}. Stop here and ask the user how to go on.` };
    }
    const waitingChats = new Set(chain.filter((r) => !isSettled(r.status)).map((r) => r.fromChatId));

    // Every target is checked before anything is made, so a bad one sends nothing.
    const resolved: ({ chat: Chat } | { app: App; text: string; machine: string })[] = [];
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
        const machine = this.appMachineOf(app);
        // With no paired machines to hand it to, an app whose folder isn't here can't be sent to, as before.
        if (machine === null || (machine !== this.selfId() && !this.deps.remote)) {
          const folder = this.deps.resolveWorkspace(app.workspace);
          const why = folder.status === 'unresolved' ? workspaceUnresolvedMessage(folder) : 'it has no folder anywhere.';
          return { refused: `The app "${app.name}" has no folder on this machine: ${why}` };
        }
        const why = this.machineRefusal(machine, `The app "${app.name}"`);
        if (why) return { refused: why };
        resolved.push({ app, text: t.text, machine });
      }
    }

    const self = this.selfId();
    const appNames = new Map(this.store.apps.list().map((a) => [a.id, a.name]));
    const touched = new Set<string>([ctx.chatId]);
    const made: { row: ChatSend; title: string; app: string | null }[] = [];
    for (const [i, target] of resolved.entries()) {
      const text = targets[i]!.text;
      // A new chat in an app whose folder is on a paired machine is made there, when it is handed over.
      const elsewhere = 'app' in target && target.machine !== self;
      const chat = 'chat' in target ? target.chat : elsewhere ? null : this.deps.createAppChat(target.app, titleFrom(target.text));
      const toNode = 'chat' in target ? (target.chat.runsOn === self ? null : target.chat.runsOn) : elsewhere ? target.machine : null;
      const row = this.store.chatSends.create({
        id: this.generateId(),
        chainId,
        depth: depth + 1,
        fromChatId: ctx.chatId,
        fromMessageId: ctx.messageId,
        toChatId: chat?.id ?? this.generateId(),
        createdChat: 'app' in target,
        text,
        status: 'queued',
        toReplyId: null,
        replyText: null,
        reason: null,
        resumedAs: null,
        createdAt: this.now(),
        toNode,
        toAppId: 'app' in target ? target.app.id : null,
      });
      touched.add(row.toChatId);
      const app = 'app' in target ? target.app.name : chat?.appId ? (appNames.get(chat.appId) ?? null) : null;
      made.push({ row, title: chat?.title ?? titleFrom(text), app });
    }
    this.changed([...touched]);
    for (const { row } of made) if (row.toNode === null) this.drain(row.toChatId);
    // Handed over before answering, so the model is told which ones wait for a machine that is off.
    await Promise.all(made.filter(({ row }) => row.toNode !== null).map(({ row }) => this.handOverRow(row.id)));
    const sent = made.map(({ row, title, app }) => {
      const now = this.store.chatSends.get(row.id) ?? row;
      return {
        sendId: row.id,
        chatId: row.toChatId,
        title,
        app,
        createdChat: row.createdChat,
        queued: row.toNode === null && this.isBusy(row.toChatId),
        machine: this.machineName(row.toNode ?? self),
        held: now.status === 'queued' && now.heldReason !== null,
      };
    });
    return { sent };
  }

  /** Why a chat or app on `nodeId` can't be sent to, or null. */
  private machineRefusal(nodeId: string, what: string): string | null {
    if (nodeId === this.selfId()) return null;
    if (!this.reachableMachine(nodeId)) return `${what} runs on ${this.store.peers.get(nodeId)?.name ?? 'another machine'}; only chats on this machine and paired ones can be sent work.`;
    if (this.deps.remote?.state(nodeId) === 'off') return sendsOffReason(this.machineName(nodeId));
    return null;
  }

  /**
   * Hands one queued send to the paired machine its target runs on. Off: it is held (the user is told once) and
   * tried again on every tick. Taken: it runs there. A final refusal fails it, and its sender carries on.
   */
  private async handOverRow(id: string): Promise<void> {
    const remote = this.deps.remote;
    const row = this.store.chatSends.get(id);
    if (!remote || !row || row.status !== 'queued' || row.toNode === null || this.handing.has(id)) return;
    const machine = this.machineName(row.toNode);
    if (remote.state(row.toNode) === 'unreachable') {
      this.hold(row, unreachableReason(machine));
      return;
    }
    this.handing.add(id);
    let answer: HandoverAnswer;
    try {
      answer = await remote.handOver(row.toNode, this.handoverOf(row));
    } catch (err) {
      console.error('[ChatSendService] handing a send over failed:', err);
      answer = { refused: unreachableReason(machine), final: false };
    } finally {
      this.handing.delete(id);
    }
    const now = this.store.chatSends.get(id);
    if (!now) return;
    if ('accepted' in answer) {
      if (now.status === 'queued') {
        this.store.chatSends.update(id, { status: 'running', handedAt: this.now(), heldReason: null, heldSeen: false });
        this.changed([now.fromChatId, now.toChatId]);
      } else if (now.status === 'stopped' || now.status === 'cancelled') {
        // Stopped or cancelled while it was being handed over: the machine that took it is told to stop.
        this.store.chatSends.update(id, { stopPending: now.reason ?? STOPPED_FROM_CARD });
        this.tellStop(id);
      }
      return;
    }
    if (now.status !== 'queued') return;
    if (answer.final) {
      this.settle(id, 'failed', null, answer.refused);
      this.maybeResume(now.fromMessageId);
      return;
    }
    this.hold(now, answer.refused);
  }

  /** Marks a send as waiting for its machine, saying so once (`chat-send-held`) when it starts waiting. */
  private hold(row: ChatSend, reason: string): void {
    if (row.heldReason === reason) return;
    this.store.chatSends.update(row.id, { heldReason: reason });
    this.changed([row.fromChatId]);
    if (row.heldReason === null) this.deps.emit({ type: 'chat-send-held', chatId: row.fromChatId, sendId: row.id, machine: this.machineName(row.toNode!), reason });
  }

  /** The send as the target's machine is handed it. */
  private handoverOf(row: ChatSend): Handover {
    const from = this.store.chats.get(row.fromChatId);
    const appName = from?.appId ? (this.store.apps.get(from.appId)?.name ?? null) : null;
    const app = row.toAppId !== null && this.store.chats.get(row.toChatId) === null ? this.store.apps.get(row.toAppId) : null;
    return {
      id: row.id,
      chainId: row.chainId,
      depth: row.depth,
      chainBase: this.chainCount(row.chainId) - 1,
      fromChatId: row.fromChatId,
      fromMessageId: row.fromMessageId,
      fromTitle: from?.title ?? row.fromTitle ?? 'a chat that has since been deleted',
      fromAppName: appName,
      toChatId: row.toChatId,
      text: row.text,
      ...(app ? { createApp: { appId: app.id, title: titleFrom(row.text) } } : {}),
    };
  }

  /** Everything still owed to a paired machine: handovers, stops and outcome reports, each tried again until taken. */
  private remoteAll(): void {
    if (!this.deps.remote) return;
    for (const row of this.store.chatSends.remoteWork()) {
      if (row.toNode !== null && row.status === 'queued') this.track(this.handOverRow(row.id));
      else if (row.stopPending !== null) this.tellStop(row.id);
    }
  }

  /** Tells the target's machine to stop a send, once at a time; a send it took keeps `stopPending` until it does. */
  private tellStop(id: string): void {
    const remote = this.deps.remote;
    const row = this.store.chatSends.get(id);
    if (!remote || !row || row.toNode === null || row.stopPending === null || this.telling.has(id)) return;
    this.telling.add(id);
    const { toNode, toChatId, stopPending } = row;
    this.track(
      (async () => {
        try {
          if ((await remote.stop(toNode, id, toChatId, stopPending)) === 'taken') this.store.chatSends.update(id, { stopPending: null });
        } finally {
          this.telling.delete(id);
        }
      })()
    );
  }

  /**
   * How a send this machine handed to `fromNode` ended there. Only that machine can settle it; a send already
   * settled here (stopped from the card meanwhile) is taken and left as it is, so the other machine stops telling.
   */
  takeOutcome(fromNode: string, sendId: string, o: Outcome): 'taken' | 'unknown' {
    const row = this.store.chatSends.get(sendId);
    if (!row || row.toNode !== fromNode) return 'unknown';
    if (isSettled(row.status)) return 'taken';
    this.settle(row.id, o.status, o.replyText === null ? null : cutReply(o.replyText), o.reason);
    this.maybeResume(row.fromMessageId);
    return 'taken';
  }

  /** The send card's Cancel on a send held for a machine: it ends `cancelled`, and its sender carries on without it. */
  cancel(sendId: string): boolean {
    const row = this.store.chatSends.get(sendId);
    if (!row || row.toNode === null || row.status !== 'queued') return false;
    this.store.chatSends.update(sendId, { heldReason: null });
    this.settle(sendId, 'cancelled', null, CANCELLED_BY_USER);
    this.maybeResume(row.fromMessageId);
    return true;
  }

  /** The send card's Wait: the held send goes when its machine is back, and stops needing the user. */
  wait(sendId: string): boolean {
    const row = this.store.chatSends.get(sendId);
    if (!row || row.toNode === null || row.status !== 'queued' || row.heldReason === null) return false;
    this.store.chatSends.update(sendId, { heldSeen: true });
    this.changed([row.fromChatId]);
    return true;
  }

  /** Whether a send waiting for a paired machine could run on this one instead: no folder, or its folder is here. */
  canRunHere(row: ChatSend): boolean {
    if (row.toNode === null) return false;
    const chat = this.store.chats.get(row.toChatId);
    const app = !chat && row.toAppId !== null ? this.store.apps.get(row.toAppId) : null;
    if (!chat && !app) return false;
    const status = this.deps.resolveWorkspace((chat ? chat.workspace : app!.workspace) ?? null, this.selfId()).status;
    return status === 'ok' || status === 'none';
  }

  /**
   * The send card's Run here, for a send waiting for its machine: the chat moves to this machine (or the new app
   * chat is made here) and the message goes out here.
   */
  async runHere(sendId: string): Promise<{ ok: true } | { refused: string }> {
    const row = this.store.chatSends.get(sendId);
    if (!row || row.toNode === null || row.status !== 'queued') return { refused: "That message isn't waiting for another machine." };
    if (this.handing.has(sendId)) return { refused: 'It is being handed over right now. Try again in a moment.' };
    const chat = this.store.chats.get(row.toChatId);
    const app = row.toAppId !== null ? this.store.apps.get(row.toAppId) : null;
    if (!this.canRunHere(row)) return { refused: notHereReason(chat?.title ?? app?.name ?? 'That chat', this.machineName(row.toNode)) };
    if (chat) this.store.chats.update(chat.id, { runsOn: this.selfId() });
    else if (app) this.deps.createAppChat(app, titleFrom(row.text), row.toChatId);
    this.store.chatSends.update(sendId, { toNode: null, heldReason: null, heldSeen: false });
    this.changed([row.fromChatId, row.toChatId]);
    this.drain(row.toChatId);
    return { ok: true };
  }

  /** The sends from or to `chatId` as the send card reads them. */
  views(chatId: string): ChatSendView[] {
    return this.sendsOf(chatId).map((r) => ({ ...r, machine: r.toNode === null ? null : this.machineName(r.toNode), canRunHere: r.status === 'queued' && this.canRunHere(r) }));
  }

  /** Why a chat can't be sent to, or null. */
  private targetRefusal(senderId: string, chatId: string, chat: Chat | null, waitingChats: ReadonlySet<string>): string | null {
    if (chatId === senderId) return "A chat can't send work to itself.";
    if (!chat) return `There is no chat ${chatId}. Use list to see the chats you can send to.`;
    if (chat.archivedAt !== null) return `The chat "${chat.title}" is archived.`;
    if (chat.runsOn !== this.selfId()) {
      if (!this.deps.remote) {
        const machine = this.store.peers.get(chat.runsOn)?.name ?? 'another machine';
        return `The chat "${chat.title}" runs on ${machine}; only chats on this machine can be sent work.`;
      }
      const why = this.machineRefusal(chat.runsOn, `The chat "${chat.title}"`);
      if (why) return why;
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
    for (const chatId of new Set(this.store.chatSends.unsettled().filter((r) => r.status === 'queued' && r.toNode === null).map((r) => r.toChatId))) this.drain(chatId);
  }

  /**
   * Starts the oldest message waiting for `chatId`, if the chat is free: no reply running, none of the user's
   * own messages waiting, and nothing else being started there by this service. A chat that has gone fails
   * everything waiting for it.
   */
  private drain(chatId: string): void {
    if (this.starting.has(chatId)) return;
    // Rows handed to a paired machine are delivered there.
    const queued = this.store.chatSends.byToChat(chatId).filter((r) => r.status === 'queued' && r.toNode === null);
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
      // Stopped (or settled some other way) while the profile resolved: nothing goes out.
      if (this.store.chatSends.get(row.id)?.status !== 'queued') return;
      // The user started something there meanwhile: it stays queued and goes when that ends.
      if (this.isBusy(now.id)) return;
      const parentId = chatTip(this.store, now.id, now.headMessageId);
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
    // Stopped while its turn was starting: that turn is stopped too, and the row keeps its stop.
    if (this.store.chatSends.get(row.id)?.status !== 'queued') {
      this.deps.turnRunner.cancel(replyId);
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
    if (status !== 'complete' && out.length > 0) {
      // It won't carry on, so neither does anything it sent, even what already replied.
      this.stopTree(replyId, SENDER_STOPPED);
      this.closeGroup(replyId);
    }
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
          // Stopped from above (a restart reconciles a stopped reply as an error): a stop, not a failure.
          else if (row.reason !== null && NO_RESUME_REASONS.has(row.reason)) this.settle(row.id, 'stopped', null, row.reason);
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
    const sender = this.store.chats.get(group[0]!.fromChatId);
    if (!sender) {
      this.close(fromMessageId, 'dropped', TARGET_DELETED);
      return;
    }
    if (lineAfter({ store: this.store }, sender.headMessageId, fromMessageId)) {
      this.close(fromMessageId, 'dropped', TARGET_CLEARED);
      return;
    }
    this.due.add(fromMessageId);
    this.resumeDue();
  }

  /**
   * Closes a group with no resume, and ends whatever its sending reply was working on for another chat, with
   * `reason` as that chat is told it (from its side: the chat it sent to).
   */
  private close(fromMessageId: string, status: ChatSendStatus, reason: string): void {
    this.closeGroup(fromMessageId);
    this.settleServed(fromMessageId, status, reason);
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
      // Closed (stopped, cleared) or busy again while the profile resolved: closed stays closed, busy waits its turn.
      if (this.store.chatSends.byFromMessage(fromMessageId).some((r) => r.resumedAs !== null)) return;
      if (this.isBusy(chat.id)) {
        this.due.add(fromMessageId);
        return;
      }
      let parentId: string | null;
      try {
        parentId = chatTip(this.store, chat.id, this.store.chats.get(chat.id)?.headMessageId ?? null);
      } catch {
        parentId = fromMessageId;
      }
      const rows = group.map((r) => ({ row: r, title: this.targetTitle(r) }));
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
      this.close(fromMessageId, 'failed', `The chat it was sent to couldn't carry on: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const row of group) this.store.chatSends.update(row.id, { resumedAs: replyId });
    for (const row of this.store.chatSends.byToReply(fromMessageId).filter((r) => !isSettled(r.status))) this.store.chatSends.update(row.id, { toReplyId: replyId });
    this.changed([chatId, ...group.map((r) => r.toChatId)]);
    const status = this.store.messages.get(replyId)?.status;
    if (status !== undefined && status !== 'streaming') this.onReplyEnded(replyId, status);
  }

  /** A target chat's title; a new app chat made on a paired machine may not have synced here yet. */
  private targetTitle(row: ChatSend): string {
    const chat = this.store.chats.get(row.toChatId);
    if (chat) return chat.title;
    if (row.toAppId !== null && row.toNode !== null) return `${titleFrom(row.text)} (a new chat in ${this.store.apps.get(row.toAppId)?.name ?? 'an app'})`;
    return 'a chat that has since been deleted';
  }

  /** The rows of every send from or to `chatId`, newest first, at most 200. */
  sendsOf(chatId: string): ChatSend[] {
    const rows = new Map<string, ChatSend>();
    for (const r of [...this.store.chatSends.byFromChat(chatId), ...this.store.chatSends.byToChat(chatId)]) rows.set(r.id, r);
    return [...rows.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  }
}
