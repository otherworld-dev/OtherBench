import type { Store } from '../ports/store.js';
import type { CanonMessage, SerializedError } from '../types/messages.js';

/**
 * Recorded on every message `reconcileInterruptedTurns` moves out of
 * `streaming`, so both the UI and any code checking `error.kind` can tell
 * this apart from a real provider failure -- this was Grunt's own process
 * dying, not the model or the connection.
 */
export const INTERRUPTED_BY_RESTART_ERROR: SerializedError = {
  kind: 'transient',
  message:
    'This response was interrupted when Grunt restarted before the turn finished. ' +
    'Any partial output above was kept; you can retry.',
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
 * packages/server/src/container.ts). By construction every `streaming` row
 * found here is orphaned, never a race with a still-live stream: a single
 * Grunt server process holds `TurnRunner.controllers` only in memory, so
 * that map -- and therefore every stream it could still be driving -- is
 * necessarily empty the instant a fresh process opens its database.
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
 * only `status` and `error` change.
 *
 * @returns Every message that was reconciled, in their new (post-update)
 *   state -- for startup logging; callers that don't care can ignore it.
 */
export function reconcileInterruptedTurns(store: Store): CanonMessage[] {
  const orphaned = store.messages.listByStatus('streaming');
  const reconciled: CanonMessage[] = [];
  for (const message of orphaned) {
    store.messages.updateStatus(message.id, 'error', INTERRUPTED_BY_RESTART_ERROR);
    const updated = store.messages.get(message.id);
    if (updated) reconciled.push(updated);
  }
  return reconciled;
}
