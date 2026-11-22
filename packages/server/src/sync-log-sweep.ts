import type { Store } from '@otherbench/core/ports/store.js';

/** How often a running server tidies its change log and tombstones. */
export const SYNC_LOG_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How long after starting the first pass runs: once the start-up work and the first pulls are out of the way. */
export const SYNC_LOG_SWEEP_FIRST_MS = 2 * 60 * 1000;
/** Logged rows looked at per step. A step is one short transaction; the event loop gets a turn between steps. */
export const SYNC_LOG_SWEEP_STEP = 500;

export interface SyncLogSweepDeps {
  store: Store;
  /** The clock, `Date.now` unless a test fixes it. */
  now?: () => number;
  step?: number;
  /** Lets the rest of the server run between steps; a turn of the event loop unless a test replaces it. */
  pause?: () => Promise<void>;
}

/**
 * One pass of the store's `pruneLog` over the whole change log, a bounded step at a time: the first pass on an old
 * database may have years of entries to drop, and the database is synchronous, so each step is kept short and the
 * event loop runs between them. `stopped` ends it early (the store is about to close); the next pass starts again
 * from the beginning, which costs nothing as what was dropped is gone. Never throws: this is cleanup, and a failure
 * is logged.
 */
export async function runSyncLogSweep(deps: SyncLogSweepDeps, stopped: () => boolean = () => false): Promise<{ entries: number; tombstones: number }> {
  const total = { entries: 0, tombstones: 0 };
  const sync = deps.store.sync;
  if (!sync) return total;
  const pause = deps.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  try {
    const now = (deps.now ?? Date.now)();
    let after: string | null = null;
    do {
      if (stopped()) break;
      const step = sync.pruneLog({ now, limit: deps.step ?? SYNC_LOG_SWEEP_STEP, after });
      total.entries += step.entries;
      total.tombstones += step.tombstones;
      after = step.after;
      if (after !== null) await pause();
    } while (after !== null);
    if (total.entries > 0 || total.tombstones > 0) console.warn(`[otherbench-server] tidied the change log: ${total.entries} entr${total.entries === 1 ? 'y' : 'ies'} and ${total.tombstones} tombstone(s) dropped.`);
  } catch (err) {
    console.error('[otherbench-server] change log tidy failed:', err);
  }
  return total;
}

export interface SyncLogSweeper {
  /** Stops the timers and any pass in progress at its next step; call before the store closes. */
  stop(): void;
  /** Settles once the pass in progress, if any, has finished. */
  idle(): Promise<void>;
}

/**
 * Tidies the log a little after the server starts and every `SYNC_LOG_SWEEP_INTERVAL_MS` after, as the abandoned
 * attachment sweep runs. The timers are unref'd and a pass never overlaps the one before.
 */
export function startSyncLogSweep(deps: SyncLogSweepDeps, timing: { firstMs?: number; intervalMs?: number } = {}): SyncLogSweeper {
  let stopped = false;
  let running: Promise<void> | null = null;
  const pass = (): void => {
    if (stopped || running) return;
    running = runSyncLogSweep(deps, () => stopped).then(() => {
      running = null;
    });
  };
  const first = setTimeout(pass, timing.firstMs ?? SYNC_LOG_SWEEP_FIRST_MS);
  const timer = setInterval(pass, timing.intervalMs ?? SYNC_LOG_SWEEP_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
    },
    idle: () => running ?? Promise.resolve(),
  };
}
