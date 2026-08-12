import type { TurnEvent, TurnRunner } from '@grunt/core/domain/turn.js';
import type { MessageStatus } from '@grunt/core/types/messages.js';

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
 */
export class StreamRegistry {
  private readonly buffers = new Map<string, StreamBuffer>();
  private readonly chatSubscribers = new Map<string, Set<(e: TurnEvent) => void>>();
  private readonly evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retentionMs: number;

  constructor(turnRunner: TurnRunner, options: StreamRegistryOptions = {}) {
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

    const subscribers = this.chatSubscribers.get(buffer.chatId);
    if (subscribers) {
      for (const cb of subscribers) cb(event);
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

  /** Every buffer (in-flight, or completed within the retention window) belonging to `chatId`. */
  snapshot(chatId: string): StreamBuffer[] {
    return [...this.buffers.values()].filter((b) => b.chatId === chatId);
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
