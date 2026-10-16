import type { DatabaseSync } from 'node:sqlite';
import { Hlc } from '@otherbench/core/domain/hlc.js';
import { selfIdOf } from './nodes.js';

/**
 * The stamps a store writes into synced rows (migration 013): one hybrid
 * logical clock per store, shared by every repository so stamps are ordered
 * across tables.
 */
export interface SyncClock {
  /** A stamp for a change being written now. */
  stamp(): string;
  /** Moves past a stamp from another machine. */
  observe(hlc: string): void;
  /** Sets the stamp the delete triggers give the tombstones of the next delete (and everything it cascades to). */
  markDelete(hlc?: string): void;
}

export function clockOf(db: DatabaseSync, selfId: () => string = selfIdOf(db)): SyncClock {
  let hlc: Hlc | null = null;
  const clock = (): Hlc => (hlc ??= new Hlc(selfId()));
  const setDelete = db.prepare("UPDATE sync_state SET value = ? WHERE key = 'delete_hlc'");
  return {
    stamp: () => clock().tick(),
    observe: (stamp) => clock().observe(stamp),
    markDelete: (stamp) => {
      setDelete.run(stamp ?? clock().tick());
    },
  };
}
