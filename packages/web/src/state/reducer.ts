import type { TurnEvent } from '@otherbench/core/domain/turn.js';
import type { MediaProgress } from '@otherbench/core/ports/media.js';
import type { ApprovalRequest, UserAsk } from '@otherbench/core/ports/tool-provider.js';
import type { CanonMessage, MessageStatus, Part } from '@otherbench/core/types/messages.js';
import type { Usage } from '@otherbench/core/types/usage.js';
import { appendDelta, applySubagentEvent, isSubagentEvent } from '@otherbench/core/domain/parts.js';

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
  /** Questions and plans this message's tool calls are waiting on (spec 2026-10-12-thread-cards-design). Absent means none. */
  pendingAsks?: UserAsk[];
  /** The latest progress of each generation call still running, by tool call id. Absent means none. */
  progressByCall?: Record<string, MediaProgress>;
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
        extras: withoutProgress(extras, event.id),
      };
    case 'user-note':
      return { message: { ...message, parts: [...message.parts, event.part] }, extras };
    case 'finish':
      return { message, extras: { ...extras, usage: event.usage } };
    case 'error': {
      // `error` does NOT end the turn on the server: the runner records it and
      // keeps reading the stream (a tool may still be waiting on its card, and
      // Stop must stay available). So neither the card nor the streaming
      // status is touched here -- the terminal `status` event that always
      // follows teardown sets the final status and drops the cards.
      return { message: { ...message, status: message.status, error: event.error }, extras };
    }
    case 'status':
      // A message that is no longer streaming cannot be waiting on anyone: drop
      // any approval card still showing (the server settles these as denials,
      // but the `approval-resolved` may be lost to a reconnect or arrive late).
      return { message: { ...message, status: event.status }, extras: event.status === 'streaming' ? extras : withoutApprovals(extras) };
    case 'notice':
      // Task 21's capability-fallback disclosure -- appended as its own
      // Part (never merged into an adjacent text part, unlike
      // text-delta/reasoning-delta above), matching exactly what
      // TurnRunner.runVariant persists server-side, so a client that only
      // hydrates from GET .../messages later reconstructs an identical
      // parts array.
      return { message: { ...message, parts: [...message.parts, { type: 'notice', text: event.text }] }, extras };
    case 'context-summary': {
      // Same part TurnRunner stores, so a later reload reconstructs it identically.
      const part: Part = {
        type: 'context-summary',
        text: event.text,
        ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
        ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
      };
      return { message: { ...message, parts: [...message.parts, part] }, extras };
    }
    case 'approval-request':
      return { message, extras: { ...extras, pendingApprovals: [...extras.pendingApprovals, event.request] } };
    case 'approval-resolved':
      return {
        message,
        extras: { ...extras, pendingApprovals: extras.pendingApprovals.filter((r) => r.id !== event.requestId) },
      };
    case 'ask-request':
      return { message, extras: { ...extras, pendingAsks: [...(extras.pendingAsks ?? []), event.ask] } };
    case 'ask-resolved':
      return { message, extras: { ...extras, pendingAsks: (extras.pendingAsks ?? []).filter((a) => a.id !== event.askId) } };
    case 'tool-progress':
      if (typeof event.callId !== 'string' || typeof event.progress !== 'object' || event.progress === null) return { message, extras };
      return { message, extras: { ...extras, progressByCall: { ...extras.progressByCall, [event.callId]: event.progress } } };
    case 'subagent':
      // The same fold the server checkpoints with (core domain/parts.ts), so a
      // live card and one rebuilt from the store agree. A hello replay starts
      // from clean parts (applyHelloBuffer), so it never doubles a card. A
      // malformed event (a bad relay, a newer server) is ignored, not folded.
      if (typeof event.callId !== 'string' || !isSubagentEvent(event.event)) return { message, extras };
      return { message: { ...message, parts: applySubagentEvent(message.parts, event.callId, event.event) }, extras };
    default:
      return { message, extras };
  }
}

/** A message no longer streaming waits on no card and runs no generation. */
function withoutApprovals(extras: MessageExtras): MessageExtras {
  const running = Object.keys(extras.progressByCall ?? {}).length > 0;
  if (extras.pendingApprovals.length === 0 && (extras.pendingAsks ?? []).length === 0 && !running) return extras;
  return { ...extras, pendingApprovals: [], pendingAsks: [], progressByCall: {} };
}

function withoutProgress(extras: MessageExtras, callId: string): MessageExtras {
  if (!extras.progressByCall || !Object.hasOwn(extras.progressByCall, callId)) return extras;
  const { [callId]: _done, ...rest } = extras.progressByCall;
  return { ...extras, progressByCall: rest };
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
