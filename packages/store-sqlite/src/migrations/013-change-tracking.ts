import type { DatabaseSync } from 'node:sqlite';
import { defaultAvailability } from '@grunt/core/domain/availability.js';
import { CHAT_FIELDS } from '@grunt/core/domain/sync.js';
import type { ConnectionKind } from '@grunt/core/types/config.js';
import type { Migration } from './types.js';

const CHAT_FIELD_NAMES = Object.keys(CHAT_FIELDS);

// Migration 013: change tracking for sync (v2 plan, Task 49; spec §4).
//
// Every synced table gets an `hlc` column the repositories stamp from a
// hybrid logical clock on each real change (chat also gets `field_hlc`, a
// stamp per field). Triggers append each change to `change_log` -- an
// update only when its stamp changed, so a streaming checkpoint or a
// connection health check never counts -- and a delete also records a
// tombstone, stamped from `sync_state.delete_hlc`, which the deleting code
// sets first. Triggers (rather than repository code) catch the deletes
// that cascade through foreign keys. A message is only logged once it's no
// longer streaming. The backfill stamps every existing row, which logs it:
// the first sync with a new peer sends everything.
//
// connection also gets `availability` ('anywhere' or the node id it's bound
// to) and `sync_secret` (0 keeps its API key on this machine), Task 51.

interface Tracked {
  table: string;
  /** The row's key as text, for `change_log.row_id` and `tombstone.row_id`. */
  key: (row: 'NEW' | 'OLD') => string;
  /** Extra condition for logging an insert or update. */
  when?: string;
  /** What the backfill stamps existing rows with: a millisecond column, or now. */
  stampFrom?: string;
}

const byId = (row: 'NEW' | 'OLD'): string => `${row}.id`;

export const TRACKED_TABLES: Tracked[] = [
  { table: 'location', key: byId },
  { table: 'location_path', key: (r) => `${r}.location_id || ':' || ${r}.node_id` },
  { table: 'connection', key: byId },
  { table: 'model', key: byId },
  { table: 'profile', key: byId },
  { table: 'project', key: byId, stampFrom: 'updated_at' },
  { table: 'project_memory', key: (r) => `${r}.project_id`, stampFrom: 'updated_at' },
  { table: 'chat', key: byId, stampFrom: 'updated_at' },
  { table: 'message', key: byId, when: "NEW.status != 'streaming'", stampFrom: 'created_at' },
  { table: 'attachment', key: byId },
  { table: 'usage', key: byId },
];

function triggers(t: Tracked): string {
  const insertWhen = t.when ? ` WHEN ${t.when}` : '';
  const updateWhen = ` WHEN NEW.hlc IS NOT OLD.hlc${t.when ? ` AND ${t.when}` : ''}`;
  return `
CREATE TRIGGER sync_${t.table}_ai AFTER INSERT ON ${t.table}${insertWhen} BEGIN
  INSERT INTO change_log (tbl, row_id, op) VALUES ('${t.table}', ${t.key('NEW')}, 'upsert');
END;
CREATE TRIGGER sync_${t.table}_au AFTER UPDATE ON ${t.table}${updateWhen} BEGIN
  INSERT INTO change_log (tbl, row_id, op) VALUES ('${t.table}', ${t.key('NEW')}, 'upsert');
END;
CREATE TRIGGER sync_${t.table}_ad AFTER DELETE ON ${t.table} BEGIN
  INSERT INTO change_log (tbl, row_id, op) VALUES ('${t.table}', ${t.key('OLD')}, 'delete');
  INSERT OR REPLACE INTO tombstone (tbl, row_id, hlc) VALUES ('${t.table}', ${t.key('OLD')}, (SELECT value FROM sync_state WHERE key = 'delete_hlc'));
END;`;
}

export const MIGRATION_013_CHANGE_TRACKING: Migration = {
  version: 13,
  name: '013-change-tracking',
  sql: `
${TRACKED_TABLES.map((t) => `ALTER TABLE ${t.table} ADD COLUMN hlc TEXT NOT NULL DEFAULT '';`).join('\n')}
ALTER TABLE chat ADD COLUMN field_hlc TEXT NOT NULL DEFAULT '{}';
ALTER TABLE connection ADD COLUMN availability TEXT NOT NULL DEFAULT 'anywhere';
ALTER TABLE connection ADD COLUMN sync_secret INTEGER NOT NULL DEFAULT 1;
CREATE TABLE change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert', 'delete'))
);
CREATE INDEX idx_change_log_row ON change_log(tbl, row_id);
CREATE TABLE tombstone (
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  PRIMARY KEY (tbl, row_id)
);
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO sync_state (key, value) VALUES ('delete_hlc', '');
${TRACKED_TABLES.map(triggers).join('\n')}
`,
  run: (db: DatabaseSync) => {
    const self = (db.prepare('SELECT id FROM node_self LIMIT 1').get() as { id: string } | undefined)?.id ?? 'unknown';
    const now = Date.now();
    for (const t of TRACKED_TABLES) {
      const ms = t.stampFrom ? `COALESCE(${t.stampFrom}, ${now})` : String(now);
      db.prepare(`UPDATE ${t.table} SET hlc = printf('%013d-0000-%s', ${ms}, ?)`).run(self);
    }
    // Every chat field starts with the row's stamp (see SqliteChatRepo.create).
    const fields = CHAT_FIELD_NAMES.map((f) => `'${f}', hlc`).join(', ');
    db.exec(`UPDATE chat SET field_hlc = json_object(${fields})`);
    // An existing connection to a loopback address (a local Ollama) only works on this machine.
    const connections = db.prepare('SELECT id, kind, base_url FROM connection').all() as { id: string; kind: ConnectionKind; base_url: string | null }[];
    for (const c of connections) {
      db.prepare('UPDATE connection SET availability = ? WHERE id = ?').run(defaultAvailability(c.kind, c.base_url, self), c.id);
    }
  },
};
