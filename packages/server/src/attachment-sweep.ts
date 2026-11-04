import type { Attachment, Store } from '@otherbench/core/ports/store.js';
import { sweepAbandonedAttachments } from '@otherbench/store-sqlite/blob-gc.js';
import type { BlobStore } from '@otherbench/store-sqlite/blob-store.js';

/** How often a running server looks for abandoned unsent attachments (it also does once at start). */
export const ABANDONED_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface AbandonedSweepDeps {
  store: Store;
  blobStore: BlobStore;
  /** An attachment on a note waiting to be sent: kept although unsent. */
  isHeld?: (attachment: Attachment) => boolean;
  /** The clock, `Date.now` unless a test fixes it. */
  now?: () => number;
}

/**
 * One pass of `sweepAbandonedAttachments` (store-sqlite's blob GC, which
 * holds the grace period and the rules). Never throws: a failure is logged,
 * as the sweep is cleanup and must never stop the server starting or
 * running.
 */
export async function runAbandonedAttachmentSweep(deps: AbandonedSweepDeps): Promise<void> {
  try {
    const { removed } = await sweepAbandonedAttachments(deps.store, deps.blobStore, {
      now: (deps.now ?? Date.now)(),
      ...(deps.isHeld ? { isHeld: deps.isHeld } : {}),
    });
    if (removed > 0) console.warn(`[otherbench-server] removed ${removed} abandoned unsent attachment(s).`);
  } catch (err) {
    console.error('[otherbench-server] abandoned attachment sweep failed:', err);
  }
}

export interface AbandonedSweeper {
  /** Stops the timer; call before the store closes. */
  stop(): void;
  /** Settles once the pass in progress, if any, has finished. */
  idle(): Promise<void>;
}

/**
 * Runs the sweep every `ABANDONED_SWEEP_INTERVAL_MS` while the server runs,
 * so a server left up for weeks still collects what the start-up pass would.
 * The timer is unref'd (it never keeps the process alive) and a pass never
 * overlaps the one before.
 */
export function startAbandonedAttachmentSweep(deps: AbandonedSweepDeps): AbandonedSweeper {
  let stopped = false;
  let running: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = runAbandonedAttachmentSweep(deps).finally(() => {
      running = null;
    });
  }, ABANDONED_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    idle: () => running ?? Promise.resolve(),
  };
}
