import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.js';

// The time of the newest stamp this database holds, kept in `sync_state.clock_ms` so the clock starts from it after a
// restart instead of from the wall clock alone (repos/clock.ts keeps it up to date from here on). Read once, here, from
// every table that carries stamps and from the tombstones: the one full pass that would be too slow to make at each start.
export const MIGRATION_053_CLOCK_MARK: Migration = {
  version: 53,
  name: '053-clock-mark',
  run: (db: DatabaseSync) => {
    const stamped = db
      .prepare("SELECT m.name AS name FROM sqlite_master m JOIN pragma_table_info(m.name) c ON c.name = 'hlc' WHERE m.type = 'table'")
      .all() as { name: string }[];
    let newest = '';
    for (const { name } of stamped) {
      const top = (db.prepare(`SELECT MAX(hlc) AS hlc FROM "${name}"`).get() as { hlc: string | null }).hlc ?? '';
      if (top > newest) newest = top;
    }
    // A stamp is `<ms:13>-<counter>-<node>`; anything else in the column counts for nothing.
    const ms = /^\d{13}-/.test(newest) ? Number(newest.slice(0, 13)) : 0;
    const kept = Number((db.prepare("SELECT value FROM sync_state WHERE key = 'clock_ms'").get() as { value: string } | undefined)?.value) || 0;
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('clock_ms', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(Math.max(ms, kept)));
  },
};
