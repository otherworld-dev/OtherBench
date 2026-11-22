import { subagentPartEvents } from '@otherbench/core/domain/parts.js';
import type { ApprovalRequest } from '@otherbench/core/ports/tool-provider.js';
import type { BackgroundHelper, ChatLevelEvent, BackgroundMark } from '@otherbench/core/types/background.js';
import type { TurnEvent, TurnRunner } from '@otherbench/core/domain/turn.js';
import type { Store } from '@otherbench/core/ports/store.js';
import type { CanonMessage, MessageStatus } from '@otherbench/core/types/messages.js';

export interface StreamBuffer {
  chatId: string;
  messageId: string;
  /**
   * The `TurnEvent`s seen for this message since the turn started, in order, with each run of the same kind of
   * delta kept as one (`handleEvent`). Replaying this builds exactly the reply a subscriber connected from the
   * start would have built.
   */
  events: TurnEvent[];
  status: MessageStatus;
}

export interface StreamRegistryOptions {
  /** How long a buffer survives after its message leaves 'streaming', so a subscriber that connects just after completion still gets the full turn. Default 60s (task 17 brief). */
  retentionMs?: number;
}

const DEFAULT_RETENTION_MS = 60_000;

/**
 * Turns one persisted message's `parts` (already coalesced by
 * TurnRunner.appendDelta -- consecutive same-kind deltas merge into a single
 * part) back into the `TurnEvent`s that would replay to produce them, plus a
 * trailing `error` event when the row carries one and a final `status`
 * event. `image`/`file` parts are never produced by a streaming delta (they
 * only ever arrive as part of a user message's initial parts, and user
 * messages are never assistant/streamed), so there is nothing to reconstruct
 * for those kinds.
 */
function reconstructEvents(message: CanonMessage): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case 'text':
        events.push({ messageId: message.id, type: 'text-delta', text: part.text });
        break;
      case 'reasoning':
        events.push({ messageId: message.id, type: 'reasoning-delta', text: part.text });
        break;
      case 'tool-call':
        events.push({ messageId: message.id, type: 'tool-call', id: part.id, name: part.name, args: part.args });
        break;
      case 'tool-result':
        events.push({
          messageId: message.id,
          type: 'tool-result',
          id: part.id,
          name: part.name,
          result: part.result,
          isError: part.isError,
        });
        break;
      case 'notice':
        // Task 21's capability-fallback disclosure -- reconstructed the same
        // way as a live `notice` TurnEvent (TurnRunner.runVariant), so a
        // client reconnecting/re-hydrating after the fact sees the exact
        // same disclosure a client watching live would have. Omitting this
        // case is exactly the kind of silent downgrade decision #3 is about:
        // a client that loaded via GET .../messages would still see it (that
        // path reads `parts` directly), but any client whose message state
        // instead gets rebuilt from THIS reconstructed buffer -- which is
        // every client on `hello`/reconnect, and is the ONLY source for a
        // buffer that already aged out of StreamRegistry's live retention --
        // would silently lose the disclosure, which is worse than never
        // having sent it.
        events.push({ messageId: message.id, type: 'notice', text: part.text });
        break;
      case 'subagent':
        // A sub-agent card is rebuilt from the same events that built it live,
        // so a client rehydrating from the store sees the same card.
        for (const event of subagentPartEvents(part)) {
          events.push({ messageId: message.id, type: 'subagent', callId: part.callId, event });
        }
        break;
      case 'context-summary':
        // A compact reply's summary, rebuilt like the live event so a reconnecting client keeps it.
        events.push({
          messageId: message.id,
          type: 'context-summary',
          text: part.text,
          ...(part.preTokens !== undefined ? { preTokens: part.preTokens } : {}),
          ...(part.postTokens !== undefined ? { postTokens: part.postTokens } : {}),
        });
        break;
      case 'user-note':
        // A note Claude read mid-reply, in place, as it came live.
        events.push({ messageId: message.id, type: 'user-note', part });
        break;
      case 'context':
      case 'image':
      case 'file':
      // A handover's request line and links come from the stored message, not the stream (the link is written after the turn).
      case 'handover-request':
      case 'handover':
      // Only ever on a user message (spec 2026-11-06-chat-to-chat-design), which is never streamed.
      case 'chat-link':
        break;
    }
  }
  if (message.error) {
    events.push({ messageId: message.id, type: 'error', error: message.error });
  }
  events.push({ messageId: message.id, type: 'status', status: message.status });
  return events;
}

/**
 * Keeps one in-memory buffer of `TurnEvent`s per message id, fed by
 * subscribing once to a `TurnRunner`'s global event stream, and fans live
 * events out to per-chat subscribers (an SSE connection, one per client).
 *
 * The buffer is the single source of truth for "replay-then-live": a
 * subscriber that reads `snapshot()` and then calls `subscribe()`
 * back-to-back (no `await` between the two -- see routes/turns.ts) gets
 * every event up to that instant from the snapshot and every event from
 * then on from the subscription, with neither a gap nor an overlap --
 * `handleEvent` is the only place buffers are mutated or fanned out, and it
 * runs synchronously to completion for each event (JS's single-threaded
 * execution means no event can land in the middle of that synchronous
 * snapshot-then-subscribe pair).
 *
 * `registerTurn` must be called (by `startTurn`, immediately after
 * `TurnRunner.run()` resolves) before any event for those message ids can
 * arrive -- it seeds an empty 'streaming' buffer so a subscriber connecting
 * before the first token still sees the turn as in-flight, and so
 * `handleEvent` has somewhere to record events that arrive before that.
 * Without it, an event for an unknown message id is silently dropped: this
 * registry has no source of truth for which chat a message belongs to
 * other than what it's told (see task-16-18-report.md for why `TurnEvent`
 * deliberately carries no `chatId` of its own).
 *
 * The in-memory log is necessarily lossy across two boundaries: a server
 * restart (every buffer is gone -- it never persisted anywhere) and the
 * retention window (a completed buffer is evicted `retentionMs` after it
 * stops streaming). Neither loses a client anything: a reply with no buffer
 * is finished and stored whole, which `GET /chats/:id/messages` gives it
 * (see `snapshot`).
 */
/** What a chat's stream subscriber hears: its replies' events, and chat-level ones (background tasks, stored messages changed). */
export type ChatStreamEvent = TurnEvent | ChatLevelEvent | (TurnEvent & BackgroundMark);

export class StreamRegistry {
  private readonly buffers = new Map<string, StreamBuffer>();
  private readonly chatSubscribers = new Map<string, Set<(e: ChatStreamEvent) => void>>();
  /** Each chat's background tasks, as the engine last reported them. */
  private readonly helpers = new Map<string, BackgroundHelper[]>();
  /** Approval cards asked for by a background helper with no reply live (spec 2026-10-17-claude-background-helpers-design), by chat and request id. */
  private readonly backgroundApprovals = new Map<string, Map<string, ApprovalRequest>>();
  private readonly evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retentionMs: number;

  constructor(
    turnRunner: TurnRunner,
    private readonly store: Store,
    options: StreamRegistryOptions = {}
  ) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    turnRunner.on((event) => this.handleEvent(event));
  }

  registerTurn(chatId: string, messageIds: string[]): void {
    for (const messageId of messageIds) {
      if (!this.buffers.has(messageId)) {
        this.buffers.set(messageId, { chatId, messageId, events: [], status: 'streaming' });
      }
    }
  }

  /**
   * Replaces `messageId`'s buffer with a fresh, empty 'streaming' one --
   * unlike `registerTurn`, unconditionally, even if a (stale) buffer already
   * exists. This is `retry`'s (task 27) counterpart to `registerTurn`: a
   * retried message is the SAME id re-streamed in place (TurnRunner.retry),
   * so without this its old buffer would still hold the failed attempt's
   * events (partial text, the terminal `error`), and a client replaying
   * "everything since the turn started" would concatenate the old failed
   * content with the new retry's -- see `applyHelloBuffer`'s doc in
   * packages/web/src/state/reducer.ts for why a buffer must be everything
   * *since this attempt* started, not since the message id was first seen.
   *
   * Must be called (by the retry route) before `TurnRunner.retry()` -- same
   * ordering requirement as `registerTurn` before `run()`, since an event
   * for a message with no buffer at all is silently dropped by
   * `handleEvent`. Cancels any pending eviction timer, since a buffer that
   * was about to be evicted for aging out of retention is no longer stale
   * once it's freshly reset.
   */
  resetBuffer(chatId: string, messageId: string): void {
    const timer = this.evictionTimers.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.evictionTimers.delete(messageId);
    }
    this.buffers.set(messageId, { chatId, messageId, events: [], status: 'streaming' });
  }

  private handleEvent(event: TurnEvent): void {
    const buffer = this.buffers.get(event.messageId);
    // A card for a reply that isn't live: a background helper's, kept for the chat until it's answered.
    // A finished reply keeps its buffer for the retention window, so a helper asking soon after its
    // reply ended still counts: in that buffer the card would be missing from a reconnect's hello.
    const live = buffer !== undefined && buffer.status === 'streaming';
    if (!live && event.type === 'approval-request') {
      const chatId = event.request.chatId;
      const pending = this.backgroundApprovals.get(chatId) ?? new Map<string, ApprovalRequest>();
      pending.set(event.request.id, event.request);
      this.backgroundApprovals.set(chatId, pending);
      this.broadcast(chatId, { ...event, background: true });
      return;
    }
    if (!live && event.type === 'approval-resolved') {
      let background = false;
      for (const [chatId, pending] of this.backgroundApprovals) {
        if (!pending.delete(event.requestId)) continue;
        background = true;
        if (pending.size === 0) this.backgroundApprovals.delete(chatId);
        this.broadcast(chatId, { ...event, background: true });
      }
      // Not a background card: one the reply itself asked for, settled just after it ended
      // (a Stop), so it goes on with that reply's events below.
      if (background || !buffer) return;
    }
    if (!buffer) return; // Unknown to us -- registerTurn() was never called for it; nothing to attach this to.

    // A run of one call's progress keeps only its latest in the buffer: a replay
    // needs no more, and a long video would otherwise fill it with steps. A
    // thinking start or stop straight after another needs only the latest too.
    // A run of text (or of reasoning) is kept as one delta holding all of it: a reply is thousands of them, and a
    // replay folds consecutive deltas of one kind into one part anyway (`appendDelta`), so it builds the same
    // reply from one. A new object each time: the event itself went to the subscribers below as it came.
    const last = buffer.events.at(-1);
    if (event.type === 'tool-progress' && last?.type === 'tool-progress' && last.callId === event.callId) buffer.events[buffer.events.length - 1] = event;
    else if (event.type === 'thinking' && last?.type === 'thinking') buffer.events[buffer.events.length - 1] = event;
    else if ((event.type === 'text-delta' || event.type === 'reasoning-delta') && last?.type === event.type) buffer.events[buffer.events.length - 1] = { ...last, text: last.text + event.text };
    else buffer.events.push(event);
    if (event.type === 'status') {
      buffer.status = event.status;
      if (event.status !== 'streaming') this.scheduleEviction(buffer);
    }

    // Each subscriber is invoked in its own try/catch so one bad callback
    // (e.g. `controller.enqueue()` in the SSE transport, racing a client
    // disconnect against its own unsubscribe) can neither stop the other
    // subscribers from receiving this event nor propagate up into
    // `TurnRunner.emit`'s caller -- see turn.ts's `emit()` for the matching
    // fix on the producer side of this same event bus.
    const subscribers = this.chatSubscribers.get(buffer.chatId);
    if (subscribers) {
      for (const cb of subscribers) {
        try {
          cb(event);
        } catch (err) {
          console.error(
            `[StreamRegistry] subscriber threw while handling '${event.type}' for message ${event.messageId} (chat ${buffer.chatId}):`,
            err
          );
        }
      }
    }
  }

  private scheduleEviction(buffer: StreamBuffer): void {
    const existing = this.evictionTimers.get(buffer.messageId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.buffers.delete(buffer.messageId);
      this.evictionTimers.delete(buffer.messageId);
    }, this.retentionMs);
    // Node-only: never let a pending eviction keep the process alive.
    timer.unref?.();
    this.evictionTimers.set(buffer.messageId, timer);
  }

  /**
   * What a client opening the chat's stream can't get from `GET /chats/:id/messages`, which it reads as it
   * connects: the chat's hello (`inFlight`). Never the chat's history: every finished reply used to be rebuilt
   * from its row and sent here, so opening a chat sent it twice and the client replayed the second copy over
   * the first.
   *
   * - Every buffer of the chat. One being written is all of the reply so far; the stored row is only its last
   *   checkpoint. One that finished within the retention window is kept in because a client's messages and its
   *   stream are two requests: a reply that ended between them, or while the client was away for a moment, was
   *   read as still being written and its end went to nobody, so the hello is what tells that client it ended.
   * - A row the store says is being written that has no buffer, rebuilt from its last checkpoint. Startup closes
   *   every such row (`reconcileInterruptedTurns`) and a buffer outlives its reply's writing, so there is none
   *   today; it is here so a client is never left showing a reply as being written with nothing said of it.
   *
   * A reply that finished longer ago than the window has no buffer and is not sent: a client that was away that
   * long reads the messages again when its stream comes back (web `useChatSync`), and a paired machine relaying
   * this stream ends such a reply from this machine's activity (`settleRemoteRuns`) and syncs its row.
   *
   * A message id comes from exactly one of the two sources, so nothing is sent twice.
   */
  snapshot(chatId: string): StreamBuffer[] {
    const live = [...this.buffers.values()].filter((b) => b.chatId === chatId);
    const buffered = new Set(live.map((b) => b.messageId));
    const unbuffered = this.store.messages
      .listByStatus('streaming')
      .filter((m) => m.chatId === chatId && m.role === 'assistant' && !buffered.has(m.id))
      .map((m) => ({ chatId, messageId: m.id, events: reconstructEvents(m), status: m.status }));
    return [...live, ...unbuffered];
  }

  /** Subscribes to live events for every message in `chatId`. Returns an unsubscribe function. */
  /** The chat's background tasks now; subscribers hear them. */
  setHelpers(chatId: string, helpers: BackgroundHelper[]): void {
    if (helpers.length === 0) this.helpers.delete(chatId);
    else this.helpers.set(chatId, helpers);
    this.broadcast(chatId, { type: 'helpers', chatId, helpers });
  }

  /** Tells the chat's subscribers its stored messages changed (a helper's card in an earlier reply), so they reload them. */
  messagesChanged(chatId: string): void {
    this.broadcast(chatId, { type: 'messages-changed', chatId });
  }

  /** What a new subscriber needs besides the replies in flight: the chat's background tasks and their open approval cards. */
  chatState(chatId: string): { helpers: BackgroundHelper[]; backgroundApprovals: ApprovalRequest[] } {
    return { helpers: this.helpers.get(chatId) ?? [], backgroundApprovals: [...(this.backgroundApprovals.get(chatId)?.values() ?? [])] };
  }

  /** Tells the chat's subscribers something about the chat itself (its waiting notes, say). */
  broadcastChat(chatId: string, event: ChatLevelEvent): void {
    this.broadcast(chatId, event);
  }

  private broadcast(chatId: string, event: ChatStreamEvent): void {
    for (const cb of this.chatSubscribers.get(chatId) ?? []) {
      try {
        cb(event);
      } catch (err) {
        console.error(`[StreamRegistry] subscriber threw while handling '${event.type}' for chat ${chatId}:`, err);
      }
    }
  }

  subscribe(chatId: string, cb: (e: ChatStreamEvent) => void): () => void {
    let subscribers = this.chatSubscribers.get(chatId);
    if (!subscribers) {
      subscribers = new Set();
      this.chatSubscribers.set(chatId, subscribers);
    }
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
      if (subscribers.size === 0) this.chatSubscribers.delete(chatId);
    };
  }
}
