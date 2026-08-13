import type { TurnEvent } from '@grunt/core/domain/turn.js';
import type { ApprovalRequest } from '@grunt/core/ports/tool-provider.js';
import type { CanonMessage, MessageStatus, Part } from '@grunt/core/types/messages.js';
import type { Usage } from '@grunt/core/types/usage.js';

/**
 * Appends streamed text (or reasoning) onto `parts`, merging into the
 * trailing part when it is already the same kind. Mirrors
 * `TurnRunner`'s private `appendDelta` (packages/core/src/domain/turn.ts) --
 * duplicated rather than imported because that one is a module-private
 * implementation detail of the server's own checkpointing, not part of any
 * package's public surface, and the two need not evolve in lockstep.
 */
function appendDelta(parts: Part[], kind: 'text' | 'reasoning', text: string): Part[] {
  const last = parts.at(-1);
  if (last && last.type === kind) {
    const merged = { ...last, text: last.text + text } as Part;
    return [...parts.slice(0, -1), merged];
  }
  return [...parts, { type: kind, text } as Part];
}

/** Everything a single message accrues from its `TurnEvent`s that isn't part of `CanonMessage` itself. */
export interface MessageExtras {
  usage: Usage | null;
  /**
   * Approval requests raised by this message's OWN tool calls that have not
   * yet been answered. An array, not a single nullable slot -- a model can
   * request more than one tool call in a single step, and each gets its own
   * independent request; this is also what a compare-turn's per-variant
   * isolation actually looks like client-side, since `ApprovalRequest`s for
   * a DIFFERENT variant live in a different message's own `extras` entry
   * entirely (see `applyTurnEvent` in store.ts, which is already keyed by
   * `event.messageId`).
   */
  pendingApprovals: ApprovalRequest[];
}

export const emptyExtras: MessageExtras = { usage: null, pendingApprovals: [] };

/**
 * Folds one `TurnEvent` onto a message, mirroring exactly what
 * `TurnRunner.runVariant` does server-side to the parts it checkpoints --
 * this is what lets the client reconstruct a message's content from the
 * same event stream the server persists from. Unrecognised event types
 * (there are none today, but `EngineEvent` may grow one) leave the message
 * untouched rather than throwing, since a forward-compatible client should
 * degrade gracefully rather than break on an event it doesn't understand.
 */
export function applyEventToMessage(
  message: CanonMessage,
  extras: MessageExtras,
  event: TurnEvent
): { message: CanonMessage; extras: MessageExtras } {
  switch (event.type) {
    case 'text-delta':
      return { message: { ...message, parts: appendDelta(message.parts, 'text', event.text) }, extras };
    case 'reasoning-delta':
      return { message: { ...message, parts: appendDelta(message.parts, 'reasoning', event.text) }, extras };
    case 'tool-call':
      return {
        message: { ...message, parts: [...message.parts, { type: 'tool-call', id: event.id, name: event.name, args: event.args }] },
        extras,
      };
    case 'tool-result':
      return {
        message: {
          ...message,
          parts: [...message.parts, { type: 'tool-result', id: event.id, name: event.name, result: event.result, isError: event.isError }],
        },
        extras,
      };
    case 'finish':
      return { message, extras: { ...extras, usage: event.usage } };
    case 'error': {
      const status: MessageStatus = event.error.kind === 'cancelled' ? 'cancelled' : 'error';
      return { message: { ...message, status, error: event.error }, extras };
    }
    case 'status':
      return { message: { ...message, status: event.status }, extras };
    case 'approval-request':
      return { message, extras: { ...extras, pendingApprovals: [...extras.pendingApprovals, event.request] } };
    case 'approval-resolved':
      return {
        message,
        extras: { ...extras, pendingApprovals: extras.pendingApprovals.filter((r) => r.id !== event.requestId) },
      };
    default:
      return { message, extras };
  }
}

/** Folds a whole ordered list of events onto a message, in order. */
export function replayEvents(
  message: CanonMessage,
  extras: MessageExtras,
  events: TurnEvent[]
): { message: CanonMessage; extras: MessageExtras } {
  let acc = { message, extras };
  for (const event of events) {
    acc = applyEventToMessage(acc.message, acc.extras, event);
  }
  return acc;
}

/**
 * Rebuilds a message's content from an authoritative "everything since the
 * turn started" event list (an SSE `hello` reply's per-message buffer --
 * see StreamRegistry's class doc in packages/server/src/stream/registry.ts).
 * Resets `parts`/`status`/`error` to empty/streaming/null FIRST, then
 * replays `events` from that clean slate, rather than folding `events` onto
 * whatever the message already holds.
 *
 * This is the crux of the reconnect-without-duplication requirement: a
 * client that received some deltas live, then reconnected and got a `hello`
 * whose buffer already contains those same deltas (because the buffer is
 * everything-since-start, not everything-since-you-last-saw), would render
 * duplicated text if it appended the replay on top of its current parts.
 * Resetting first makes replay idempotent -- the result depends only on the
 * event list, never on when or how many times it's applied.
 */
export function applyHelloBuffer(
  message: CanonMessage,
  events: TurnEvent[],
  status: MessageStatus
): { message: CanonMessage; extras: MessageExtras } {
  const clean: CanonMessage = { ...message, parts: [], status: 'streaming', error: null };
  const replayed = replayEvents(clean, emptyExtras, events);
  // `status` from the buffer is authoritative (it's StreamRegistry's own
  // bookkeeping, not re-derived from the event list) -- it wins over
  // whatever the last replayed event implied, though in practice they agree.
  return { message: { ...replayed.message, status }, extras: replayed.extras };
}
