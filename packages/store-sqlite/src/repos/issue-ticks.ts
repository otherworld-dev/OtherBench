import type { DatabaseSync } from 'node:sqlite';
import type { IssueTick, IssueTickRepo } from '@otherbench/core/ports/store.js';
import { laterThrough } from '@otherbench/core/domain/sync.js';
import { clockOf, type SyncClock } from './clock.js';

function toTick(row: Record<string, unknown>): IssueTick {
  return {
    appId: row.app_id as string,
    number: row.number as number,
    through: row.through as string,
    updatedAt: row.updated_at as number,
  };
}

/** Which GitHub issue activity the user has ticked off per app (migration 033); a synced table keyed `${app_id}#${number}`. */
export class SqliteIssueTickRepo implements IssueTickRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: SyncClock = clockOf(db)
  ) {}

  list(): IssueTick[] {
    const rows = this.db.prepare('SELECT * FROM issue_tick ORDER BY app_id ASC, number ASC').all() as Record<string, unknown>[];
    return rows.map(toTick);
  }

  /** Never lowers `through` (core's `laterThrough`); a tick that isn't later is left as it is, so nothing is sent to sync. */
  set(appId: string, number: number, through: string): IssueTick {
    const id = `${appId}#${number}`;
    const row = this.db.prepare('SELECT * FROM issue_tick WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (row && laterThrough(row.through as string, through) === row.through) return toTick(row);
    const updatedAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO issue_tick (id, app_id, number, through, updated_at, hlc) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET through = excluded.through, updated_at = excluded.updated_at, hlc = excluded.hlc`
      )
      .run(id, appId, number, through, updatedAt, this.clock.stamp());
    return { appId, number, through, updatedAt };
  }

  /** The sync trigger fires per row, so each deleted tick writes its own tombstone. */
  deleteForApp(appId: string): void {
    this.db.prepare('DELETE FROM issue_tick WHERE app_id = ?').run(appId);
  }
}
