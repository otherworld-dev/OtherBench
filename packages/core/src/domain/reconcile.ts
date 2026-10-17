import type { Store } from '../ports/store.js';
import type { CanonMessage, Part, SerializedError } from '../types/messages.js';
import { applySubagentEvent } from './parts.js';

/** Written on a sub-agent card that was still queued or running when OtherBench's process died. */
export const SUBAGENT_INTERRUPTED_MESSAGE = 'OtherBench restarted while this sub-agent was working.';

/**
 * The parts with every unfinished sub-agent card turned into an error with
 * `message`, or null when there is none. Also used for a reply kept after the
 * machine writing it went away (server peer/forward.ts).
 */
export function interruptSubagents(parts: Part[], message: string = SUBAGENT_INTERRUPTED_MESSAGE): Part[] | null {
  let changed = false;
  const next = parts.map((p): Part => {
    if (p.type !== 'subagent' || (p.status !== 'queued' && p.status !== 'running')) return p;
    changed = true;
    return { ...p, status: 'error', error: message };
  });
  return changed ? next : null;
}

/**
 * The parts with every helper card still working in the background (a Claude
 * Code helper, spec 2026-10-17-claude-background-helpers-design) ended as
 * stopped, or null when there is none. Stopped, not failed: it is what the
 * engine shows when it closes a process with helpers still running.
 */
export function stopBackgroundSubagents(parts: Part[]): Part[] | null {
  let next = parts;
  for (const p of parts) {
    if (p.type === 'subagent' && p.status === 'background') next = applySubagentEvent(next, p.callId, { type: 'end', status: 'cancelled' });
  }
  return next === parts ? null : next;
}

/**
 * Recorded on every message `reconcileInterruptedTurns` moves out of
 * `streaming`, so both the UI and any code checking `error.kind` can tell
 * this apart from a real provider failure -- this was OtherBench's own process
 * dying, not the model or the connection.
 */
export const INTERRUPTED_BY_RESTART_ERROR: SerializedError = {
  kind: 'transient',
  message:
    'This response was interrupted when OtherBench restarted before the turn finished. ' +
    'Any partial output above is still there, but retrying will clear it and start over.',
  retryable: true,
};

/**
 * Reconciles every message still marked `streaming` against reality, once,
 * at startup.
 *
 * `streaming` is `TurnRunner.runVariant`'s marker that some in-process async
 * task is actively pushing deltas into a row -- it is only ever cleared by
 * that same task reaching its own `updateStatus` call (`turn.ts`, after the
 * engine's stream ends, errors, or is aborted). If the process holding that
 * task dies first -- crash, kill, power loss, an unhandled rejection that
 * takes the process down -- the row is stuck at `streaming` forever:
 * nothing is running to ever finish it. From inside the app there is no way
 * out, either: `TurnRunner.cancel()` only aborts a live entry in its
 * in-memory `controllers` map (empty on every fresh process start, since
 * that map is never persisted), so it silently no-ops on an orphaned id;
 * and `retry()` refuses anything that isn't already `status: 'error'`. SSE
 * `hello` reconstructs the message's live status straight from the row (see
 * `StreamRegistry.snapshotFromStore`), so the UI is left showing a message
 * "streaming" that will never receive another token or reach a terminal
 * state -- a dead end only a hand-edit of the database could escape.
 *
 * Called once, synchronously after a `Store` is opened and before anything
 * else can start a new turn (see `createContainer` in
 * packages/server/src/container.ts). This assumes a single OtherBench server
 * process per database: `TurnRunner.controllers` -- the only thing that
 * could still be driving a `streaming` row -- lives only in that process's
 * memory, so it is necessarily empty the instant a fresh process opens its
 * database, making every `streaming` row that lone process finds here truly
 * orphaned.
 *
 * Nothing enforces that assumption. `openDatabase` (`packages/store-sqlite/
 * src/db.ts`) only checks that the path is local; it doesn't guard against a
 * second process, and actively enables concurrent access to the same file
 * (WAL journaling, a `busy_timeout`). This function also runs before the
 * port bind, so even a second launch destined to fail with `EADDRINUSE`
 * moments later still gets here first. If a second process does open the
 * same database while the first is mid-stream, this can flip a genuinely
 * live `streaming` row to `error` out from under it. The damage is bounded --
 * the first process's own terminal `updateStatus` call overwrites the row
 * with the real outcome once that stream finishes -- but inside the window a
 * reconnecting client sees a false error, and a Retry that lands in that same
 * window passes the `status === 'error'` gate, wipes `parts`, and starts a
 * second concurrent run against the same row: interleaved content and a
 * second billed call.
 *
 * Terminal state chosen: `error`, not `cancelled`. `retry()` deliberately
 * excludes `cancelled` (see its own doc: a user's deliberate cancellation
 * must not be silently resurrected into a fresh, billed call without them
 * asking) -- but nobody chose to interrupt this turn, the process dying did,
 * and leaving it permanently unretriable was exactly the dead end this
 * function exists to close. `error` is the one status `retry()` accepts, so
 * this restores the retry path a mid-turn restart would otherwise have
 * deleted for good.
 *
 * Whatever `parts` had already been checkpointed (TurnRunner checkpoints
 * every 500ms while streaming and unconditionally right before its own
 * terminal `updateStatus`, so an interrupted turn typically has SOME partial
 * text/tool-call content already persisted) are left completely untouched --
 * only `status` and `error` change. A `subagent` card still queued or running
 * in such a message becomes an error too (spec 2026-10-12-api-subagents-design).
 *
 * A helper card still working in the background, in any reply this machine
 * wrote (finished ones included), ends as stopped: its helper lived in a
 * Claude Code process that died with this one, so nothing will ever bring the
 * card up to date (spec 2026-10-17-claude-background-helpers-design). A reply
 * a paired machine wrote is left alone: its helpers ran there. The change is
 * stamped for sync (`reviseParts`), so paired machines stop showing the
 * helper working too, as the status change of an interrupted reply already is.
 *
 * @returns Every message that was reconciled out of `streaming`, in their
 *   new (post-update) state -- for startup logging; callers that don't care
 *   can ignore it. A finished reply that only had a helper card stopped is
 *   not among them.
 */
export function reconcileInterruptedTurns(store: Store): CanonMessage[] {
  const self = store.nodes.self().id;
  for (const message of store.messages.listWithSubagentStatus('background')) {
    if ((message.originNode ?? self) !== self) continue;
    const parts = stopBackgroundSubagents(message.parts);
    if (parts) store.messages.reviseParts(message.id, parts);
  }

  // Read after the sweep above, so a streaming reply's parts include its stopped helper cards.
  const orphaned = store.messages.listByStatus('streaming');
  const reconciled: CanonMessage[] = [];
  for (const message of orphaned) {
    const parts = interruptSubagents(message.parts);
    if (parts) store.messages.updateParts(message.id, parts);
    store.messages.updateStatus(message.id, 'error', INTERRUPTED_BY_RESTART_ERROR);
    const updated = store.messages.get(message.id);
    if (updated) reconciled.push(updated);
  }
  return reconciled;
}
