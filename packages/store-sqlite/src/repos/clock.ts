import type { DatabaseSync } from 'node:sqlite';
import { HLC_MAX_WAIT_MS, Hlc, encodeHlc, hlcTooFarAhead, hlcWorthWaitingFor, parseHlc } from '@otherbench/core/domain/hlc.js';
import { selfIdOf } from './nodes.js';

/**
 * The stamps a store writes into synced rows (migration 013): one hybrid
 * logical clock per store, shared by every repository so stamps are ordered
 * across tables.
 */
export interface SyncClock {
  /** A stamp for a change being written now. */
  stamp(): string;
  /** Moves past a stamp from another machine. False, and nothing moves, for one `tooFarAhead`. */
  observe(hlc: string): boolean;
  /**
   * Whether a stamp from another machine can be taken: 'ok', or further ahead of this machine's wall clock than
   * another machine's may be (core's `hlcTooFarAhead`): 'wait' when this machine's time will soon reach it, 'never'
   * when it is so far ahead that it is not worth asking for again (`hlcWorthWaitingFor`).
   */
  ahead(hlc: string): 'ok' | 'wait' | 'never';
  /** Sets the stamp the delete triggers give the tombstones of the next delete (and everything it cascades to). */
  markDelete(hlc?: string): void;
}

/**
 * How far the clock may run past the time written in `sync_state.clock_ms`
 * before it is written again. The clock starts this far past what it reads, so
 * it is later than every stamp given since the last write; writing on every
 * stamp instead would add a second write to each change.
 */
const CLOCK_SAVE_EVERY_MS = 1000;

/**
 * `now`: the wall clock the stamps are read from (tests pass a fixed one).
 *
 * The clock starts from the time kept in `sync_state.clock_ms` (migration
 * 053), not from nothing: after a restart with the wall clock behind the
 * newest stamp stored (it was set back, or this machine had followed another
 * whose clock runs a little fast), a change made here must still be stamped
 * later than the row it changes, or it loses to the older row on every machine
 * that has it. A kept time more than a day past the wall clock is not started
 * from: no other machine would take stamps that far ahead (`HLC_MAX_WAIT_MS`),
 * so following it would cut this machine off from the rest for good.
 */
export function clockOf(db: DatabaseSync, selfId: () => string = selfIdOf(db), now: () => number = Date.now): SyncClock {
  let hlc: Hlc | null = null;
  let kept = 0;
  const start = (): Hlc => {
    // No row on a database not yet at migration 053: the clock starts from the wall clock, as it used to.
    const row = db.prepare("SELECT value FROM sync_state WHERE key = 'clock_ms'").get() as { value: string } | undefined;
    kept = Number(row?.value) || 0;
    // Forgotten, so the next stamp writes the time this clock really runs at.
    if (kept > now() + HLC_MAX_WAIT_MS) kept = 0;
    return new Hlc(selfId(), now, kept > 0 ? encodeHlc(kept + CLOCK_SAVE_EVERY_MS, 0, '') : '');
  };
  const clock = (): Hlc => (hlc ??= start());
  const setDelete = db.prepare("UPDATE sync_state SET value = ? WHERE key = 'delete_hlc'");
  const setClock = db.prepare("INSERT INTO sync_state (key, value) VALUES ('clock_ms', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const keep = (stamp: string): void => {
    const { ms } = parseHlc(stamp);
    if (ms < kept + CLOCK_SAVE_EVERY_MS) return;
    setClock.run(String(ms));
    // Inside a transaction the write may yet be rolled back, so the next stamp writes it again.
    if (!db.isTransaction) kept = ms;
  };
  const stamp = (): string => {
    const next = clock().tick();
    keep(next);
    return next;
  };
  return {
    stamp,
    observe: (remote) => {
      if (!clock().observe(remote)) return false;
      keep(remote);
      return true;
    },
    ahead: (remote) => {
      const wall = now();
      return !hlcTooFarAhead(remote, wall) ? 'ok' : hlcWorthWaitingFor(remote, wall) ? 'wait' : 'never';
    },
    markDelete: (remote) => {
      setDelete.run(remote ?? stamp());
    },
  };
}
