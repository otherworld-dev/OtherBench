import type { LiveProcess } from './live.js';

/**
 * Asks Claude Code to drop queued note `noteId`; forgotten once it
 * confirms. Its `cancelled` frame meanwhile isn't reported dropped: the
 * caller accounts for it.
 */
export async function cancelNote(live: LiveProcess, noteId: string): Promise<boolean> {
  if (!live.query.cancelAsyncMessage) return false;
  live.cancelling.add(noteId);
  try {
    const cancelled = await live.query.cancelAsyncMessage(noteId);
    if (cancelled) live.notes.delete(noteId);
    return cancelled;
  } finally {
    live.cancelling.delete(noteId);
  }
}

/**
 * Stops the turn on `live` for reply `messageId`: its own notes are
 * cancelled first, so none starts as the turn ends, then the turn is
 * interrupted. Not with interrupt's cancel_queued, which would also drop a
 * background helper's queued report.
 */
export function stopTurn(live: LiveProcess, messageId: string): void {
  cancelNotes(live, messageId);
  void live.query.interrupt().catch(() => live.close());
}

/**
 * Asks Claude Code to drop reply `messageId`'s unstarted notes, so none
 * runs after a reply that didn't finish. Each is forgotten once Claude Code
 * confirms; one it had already started (or can't cancel) stays tracked, so
 * the pump still routes its `started` frame.
 */
export function cancelNotes(live: LiveProcess, messageId: string): void {
  for (const [id, owner] of live.notes) {
    if (owner === messageId) void cancelNote(live, id).catch(() => undefined);
  }
}
