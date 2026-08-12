import type { TurnEvent, TurnRunner } from '@grunt/core/domain/turn.js';
import type { Store } from '@grunt/core/ports/store.js';
import type { CanonMessage, MessageStatus } from '@grunt/core/types/messages.js';

export interface StreamBuffer {
  chatId: string;
  messageId: string;
  /** Every `TurnEvent` seen for this message since the turn started, in order. Replaying this reproduces exactly what a subscriber connected from the start would have seen. */
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
      case 'image':
      case 'file':
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
 * `registerTurn` must be called (by the turns route, immediately after
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
 * stops streaming). `snapshot()` covers both by falling back to the `Store`
 * for any message id it has no live buffer for -- see `snapshotFromStore`.
 */
export class StreamRegistry {
  private readonly buffers = new Map<string, StreamBuffer>();
  private readonly chatSubscribers = new Map<string, Set<(e: TurnEvent) => void>>();
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

  private handleEvent(event: TurnEvent): void {
    const buffer = this.buffers.get(event.messageId);
    if (!buffer) return; // Unknown to us -- registerTurn() was never called for it; nothing to attach this to.

    buffer.events.push(event);
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
   * Every buffer (in-flight, or completed within the retention window)
   * belonging to `chatId`, plus one reconstructed from the persisted
   * message row for every assistant message in this chat that has no live
   * buffer -- e.g. a server restart lost every in-memory buffer, or this
   * one aged out of the retention window. A message id is always served
   * from exactly one of the two sources (in-memory is preferred whenever
   * both exist, via `excludeIds` below), so a reconnecting client never
   * sees duplicated content at this seam.
   */
  snapshot(chatId: string): StreamBuffer[] {
    const live = [...this.buffers.values()].filter((b) => b.chatId === chatId);
    const excludeIds = new Set(live.map((b) => b.messageId));
    return [...live, ...this.snapshotFromStore(chatId, excludeIds)];
  }

  /**
   * Reconstructs a `StreamBuffer` for every assistant message in `chatId`
   * that isn't already covered by an in-memory buffer, straight from
   * `Store.messages`. `parts` (as of the last checkpoint -- TurnRunner
   * checkpoints every 500ms while streaming, and unconditionally at
   * completion) is turned back into the `TurnEvent`s that would have
   * produced it: one delta/tool event per part, in order, plus a trailing
   * `error` event if the row has one and a `status` event carrying the
   * row's current status. Replaying that reconstructed list reproduces
   * exactly the persisted parts -- no gap, no duplication -- the same
   * guarantee the live in-memory path provides, just built from a single
   * coalesced snapshot instead of the original delta-by-delta history.
   */
  private snapshotFromStore(chatId: string, excludeIds: Set<string>): StreamBuffer[] {
    const buffers: StreamBuffer[] = [];
    const queue = [...this.store.messages.roots(chatId)];
    while (queue.length > 0) {
      const message = queue.shift();
      if (!message) continue;
      queue.push(...this.store.messages.children(message.id));
      if (message.role !== 'assistant' || excludeIds.has(message.id)) continue;

      buffers.push({
        chatId,
        messageId: message.id,
        events: reconstructEvents(message),
        status: message.status,
      });
    }
    return buffers;
  }

  /** Subscribes to live events for every message in `chatId`. Returns an unsubscribe function. */
  subscribe(chatId: string, cb: (e: TurnEvent) => void): () => void {
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
