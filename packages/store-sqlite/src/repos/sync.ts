import type { DatabaseSync } from 'node:sqlite';
import { compareHlc, maxHlc } from '@grunt/core/domain/hlc.js';
import { SYNC_TABLES, connectionSecretRef, isSha256, isSyncTable, mergeChatFields, mergeRow, type ChangeBatch, type ChangeRow, type SyncRow, type SyncTable } from '@grunt/core/domain/sync.js';
import type { SyncApplyResult, SyncRepo } from '@grunt/core/ports/store.js';
import type { Part } from '@grunt/core/types/messages.js';
import type { SyncClock } from './clock.js';
import { deriveSearchText } from './messages.js';

/**
 * Columns that never leave this machine: connection health, whether this
 * machine shares a connection's key (each machine decides that for its own
 * copy, so another can't switch it on to be sent the key), where a blob is
 * on disk, and derived search text.
 */
const LOCAL_COLUMNS: Partial<Record<SyncTable, string[]>> = {
  connection: ['status', 'status_message', 'checked_at', 'sync_secret'],
  attachment: ['storage_path'],
  message: ['search_text'],
};
const STAMP_COLUMNS = ['hlc', 'field_hlc'];

/** Each table's key columns; most are keyed on `id`. */
const KEYS: Partial<Record<SyncTable, string[]>> = {
  location_path: ['location_id', 'node_id'],
  project_memory: ['project_id'],
};
function keyColumns(tbl: SyncTable): string[] {
  return KEYS[tbl] ?? ['id'];
}

/** The `row_id` the change log and tombstones use (location paths: `location:node`). */
function keyWhere(tbl: SyncTable): string {
  return tbl === 'location_path' ? "location_id || ':' || node_id = ?" : `${keyColumns(tbl)[0]} = ?`;
}

/** A row's own key, as a change id: what the write will actually land on. */
function rowKey(tbl: SyncTable, row: SyncRow): string | null {
  const parts = keyColumns(tbl).map((c) => row[c]);
  return parts.every((p) => typeof p === 'string' && p.length > 0) ? (parts as string[]).join(':') : null;
}

/**
 * Change tracking and applying other machines' changes over SQLite (v2 plan,
 * Tasks 49-50). The triggers from migration 013 keep the change log and
 * tombstones; this reads them out as the current state of each changed row,
 * and writes a peer's rows back under the merge rules in core's
 * domain/sync.ts. Applied rows are logged again by the same triggers with
 * their incoming stamp, so they'd forward to a third machine, and coming
 * back to the machine they came from they change nothing.
 */
export class SqliteSyncRepo implements SyncRepo {
  private readonly columnCache = new Map<string, string[]>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly selfId: () => string,
    private readonly clock: SyncClock
  ) {}

  latestSeq(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log').get() as { seq: number }).seq;
  }

  observe(hlc: string): void {
    if (hlc) this.clock.observe(hlc);
  }

  setStoragePath(attachmentId: string, path: string): void {
    // Not a change: the stamp stays, so nothing is logged.
    this.db.prepare('UPDATE attachment SET storage_path = ? WHERE id = ?').run(path, attachmentId);
  }

  missingBlobs(): { id: string; sha256: string }[] {
    const rows = this.db.prepare("SELECT id, sha256 FROM attachment WHERE storage_path = '' ORDER BY id").all() as { id: string; sha256: string }[];
    return rows.filter((r) => isSha256(r.sha256));
  }

  isSentBlob(sha256: string): boolean {
    if (!isSha256(sha256)) return false;
    return this.db.prepare('SELECT 1 FROM attachment WHERE sha256 = ? AND message_id IS NOT NULL LIMIT 1').get(sha256) !== undefined;
  }

  private columns(tbl: string): string[] {
    let cols = this.columnCache.get(tbl);
    if (!cols) {
      cols = (this.db.prepare(`PRAGMA table_info(${tbl})`).all() as { name: string }[]).map((c) => c.name);
      this.columnCache.set(tbl, cols);
    }
    return cols;
  }

  private select(tbl: SyncTable, id: string): Record<string, unknown> | null {
    return (this.db.prepare(`SELECT * FROM ${tbl} WHERE ${keyWhere(tbl)}`).get(id) as Record<string, unknown> | undefined) ?? null;
  }

  private exists(tbl: SyncTable, id: unknown): boolean {
    return typeof id === 'string' && this.db.prepare(`SELECT 1 FROM ${tbl} WHERE ${keyWhere(tbl)}`).get(id) !== undefined;
  }

  private tombstone(tbl: SyncTable, id: string): string | null {
    return (this.db.prepare('SELECT hlc FROM tombstone WHERE tbl = ? AND row_id = ?').get(tbl, id) as { hlc: string } | undefined)?.hlc ?? null;
  }

  // --- reading changes out ----------------------------------------------------

  changesSince(since: number, limit: number): ChangeBatch {
    // Each changed row once, as it is now: a row changed ten times ships
    // once. Rows go in the order of their first change in range, so a row is
    // never sent before one it was created under (a message before its
    // chat). A row changed again after this batch's end comes again in a
    // later batch; a reference it gained after this batch's end is resolved
    // then, and one within it (a chat's head message) when the batch is applied.
    const entries = this.db
      .prepare('SELECT tbl, row_id, MIN(seq) AS seq FROM change_log WHERE seq > ? GROUP BY tbl, row_id ORDER BY seq LIMIT ?')
      .all(since, limit) as { tbl: string; row_id: string; seq: number }[];
    const rows: ChangeRow[] = [];
    for (const e of entries) {
      if (!isSyncTable(e.tbl)) continue;
      const row = this.select(e.tbl, e.row_id);
      if (row) {
        // Not yet: a reply still streaming, or a file not yet sent. Each is logged again when it is.
        if (e.tbl === 'message' && row['status'] === 'streaming') continue;
        if (e.tbl === 'attachment' && row['message_id'] === null) continue;
        rows.push(this.toUpsert(e.tbl, e.row_id, row));
      } else {
        const hlc = this.tombstone(e.tbl, e.row_id);
        if (hlc !== null) rows.push({ tbl: e.tbl, id: e.row_id, op: 'delete', hlc });
      }
    }
    const more = entries.length === limit;
    return { rows, nextSeq: more ? entries[entries.length - 1]!.seq : Math.max(since, this.latestSeq()), more };
  }

  private toUpsert(tbl: SyncTable, id: string, raw: Record<string, unknown>): ChangeRow {
    const drop = new Set([...STAMP_COLUMNS, ...(LOCAL_COLUMNS[tbl] ?? [])]);
    const row: SyncRow = {};
    for (const [k, v] of Object.entries(raw)) if (!drop.has(k)) row[k] = v;
    const change: ChangeRow = { tbl, id, op: 'upsert', hlc: raw['hlc'] as string, row };
    if (tbl === 'chat') change.fieldHlc = JSON.parse((raw['field_hlc'] as string) || '{}') as Record<string, string>;
    return change;
  }

  // --- applying a peer's changes -----------------------------------------------

  apply(rows: ChangeRow[], observe: (hlc: string) => void = (h) => this.observe(h)): SyncApplyResult {
    const result: SyncApplyResult = { applied: 0, skipped: 0, attachments: [], written: [] };
    for (const r of rows) {
      observe(r.hlc);
      if (r.op === 'upsert' && r.fieldHlc) for (const h of Object.values(r.fieldHlc)) observe(h);
    }
    const order = (t: SyncTable): number => SYNC_TABLES.indexOf(t);
    const upserts = rows
      .filter((r): r is Extract<ChangeRow, { op: 'upsert' }> => r.op === 'upsert' && isSyncTable(r.tbl))
      // Parents first; messages oldest first, so a reply follows what it answers.
      .sort((a, b) => order(a.tbl) - order(b.tbl) || Number(a.row['created_at'] ?? 0) - Number(b.row['created_at'] ?? 0));
    const deletes = rows.filter((r) => r.op === 'delete' && isSyncTable(r.tbl)).sort((a, b) => order(b.tbl) - order(a.tbl));

    this.db.exec('BEGIN');
    try {
      const pendingHeads: { chatId: string; head: string; stamp: string }[] = [];
      for (const u of upserts) {
        const outcome = u.tbl === 'chat' ? this.applyChat(u, pendingHeads) : this.applyRow(u);
        if (outcome) {
          result.applied++;
          result.written.push({ tbl: u.tbl, id: u.id });
          if (u.tbl === 'attachment') result.attachments.push({ id: u.id, sha256: u.row['sha256'] as string });
        } else {
          result.skipped++;
        }
      }
      this.resolveHeads(pendingHeads);
      for (const d of deletes) {
        if (this.applyDelete(d)) result.applied++;
        else result.skipped++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return result;
  }

  /** Whether the rows a row refers to are here; nullable references to missing rows are cleared instead. */
  private parentsPresent(tbl: SyncTable, row: SyncRow): boolean {
    switch (tbl) {
      case 'location_path':
        return this.exists('location', row['location_id']);
      case 'model':
      case 'profile':
        return this.exists('connection', row['connection_id']);
      case 'project':
        if (row['default_profile_id'] != null && !this.exists('profile', row['default_profile_id'])) row['default_profile_id'] = null;
        if (row['workspace_location_id'] != null && !this.exists('location', row['workspace_location_id'])) {
          row['workspace_location_id'] = null;
          row['workspace_subpath'] = null;
        }
        return true;
      case 'project_memory':
        return this.exists('project', row['project_id']);
      case 'message':
        return this.exists('chat', row['chat_id']) && (row['parent_id'] == null || this.exists('message', row['parent_id']));
      case 'attachment':
        return this.exists('chat', row['chat_id']) && (row['message_id'] == null || this.exists('message', row['message_id']));
      case 'usage':
        return ['chat', 'message', 'profile', 'connection'].every((t) => this.exists(t as SyncTable, row[`${t}_id`]));
      case 'artifact':
        return this.exists('chat', row['chat_id']);
      case 'artifact_version':
        // message_id is deliberately not checked: a version may arrive before its reply.
        return this.exists('artifact', row['artifact_id']);
      default:
        return true;
    }
  }

  /** Writes `row` (insert or update in place: never REPLACE, which would cascade) with `hlc`. */
  private upsert(tbl: SyncTable, row: SyncRow, stamps: Record<string, string>, insertOnly: Record<string, unknown> = {}): void {
    const known = new Set(this.columns(tbl));
    const drop = new Set([...STAMP_COLUMNS, ...(LOCAL_COLUMNS[tbl] ?? [])]);
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (known.has(k) && !drop.has(k)) values[k] = v;
    if (tbl === 'message') values['search_text'] = deriveSearchText(JSON.parse((row['parts'] as string) || '[]') as Part[]);
    Object.assign(values, stamps);
    const insertValues = { ...insertOnly, ...values };
    const cols = Object.keys(insertValues);
    const keys = keyColumns(tbl);
    const updates = Object.keys(values).filter((c) => !keys.includes(c));
    this.db
      .prepare(
        `INSERT INTO ${tbl} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
         ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${updates.map((c) => `${c} = excluded.${c}`).join(', ')}`
      )
      .run(...(cols.map((c) => insertValues[c] ?? null) as (string | number | null)[]));
  }

  private applyRow(u: Extract<ChangeRow, { op: 'upsert' }>): boolean {
    const row = { ...u.row };
    // Every check below looks the row up by the change's id, and the write
    // lands on the row's own key: a change whose two differ is refused, or a
    // peer could pass the checks on one row and overwrite another.
    if (rowKey(u.tbl, row) !== u.id) return false;
    const local = this.select(u.tbl, u.id);
    if (u.tbl === 'connection') {
      // A connection whose key stays on this machine is configured here only:
      // another machine re-pointing it would send that key to its new address.
      if (local && local['sync_secret'] === 0) return false;
      // Its key is always kept under its own reference, whatever the row says,
      // so another machine can't make this one read or overwrite another secret.
      if (row['secret_ref'] != null) row['secret_ref'] = connectionSecretRef(u.id);
    }
    // A file's hash names its blob on disk: anything but a SHA-256 is refused.
    if (u.tbl === 'attachment' && !isSha256(row['sha256'])) return false;
    // A machine's own folder for a location is its to set; another machine
    // may only fill it in where there's none yet (adopting a location).
    if (u.tbl === 'location_path' && row['node_id'] === this.selfId() && local) return false;
    const tomb = this.tombstone(u.tbl, u.id);
    if (mergeRow((local?.['hlc'] as string | undefined) ?? null, u.hlc, tomb, u.tbl === 'location_path') === 'skip') return false;
    if (!this.parentsPresent(u.tbl, row)) return false;
    // Columns only this machine sets get their defaults on a new row.
    const insertOnly: Record<string, unknown> = u.tbl === 'attachment' ? { storage_path: '' } : {};
    this.upsert(u.tbl, row, { hlc: u.hlc }, insertOnly);
    if (tomb !== null) this.db.prepare('DELETE FROM tombstone WHERE tbl = ? AND row_id = ?').run(u.tbl, u.id);
    return true;
  }

  private applyChat(u: Extract<ChangeRow, { op: 'upsert' }>, pendingHeads: { chatId: string; head: string; stamp: string }[]): boolean {
    // As in applyRow: the change's id and the row's own key must agree.
    if (rowKey('chat', u.row) !== u.id) return false;
    if (this.tombstone('chat', u.id) !== null) return false;
    const local = this.select('chat', u.id);
    const accept = (field: string, row: SyncRow): boolean => {
      if (field === 'profileId') return this.exists('profile', row['profile_id']);
      if (field === 'projectId') return row['project_id'] == null || this.exists('project', row['project_id']);
      if (field === 'workspace') return row['workspace_location_id'] == null || this.exists('location', row['workspace_location_id']);
      if (field === 'headMessageId') {
        if (row['head_message_id'] == null || this.exists('message', row['head_message_id'])) return true;
        // The message may be later in this batch: take the head once it's here.
        pendingHeads.push({ chatId: u.id, head: row['head_message_id'] as string, stamp: u.fieldHlc?.['headMessageId'] ?? u.hlc });
        return false;
      }
      return true;
    };
    if (!local && !this.exists('profile', u.row['profile_id'])) return false;
    const merged = mergeChatFields(
      local ? { row: local, hlc: local['hlc'] as string, fieldHlc: JSON.parse((local['field_hlc'] as string) || '{}') as Record<string, string> } : null,
      { row: u.row, hlc: u.hlc, fieldHlc: u.fieldHlc ?? {} },
      accept
    );
    if (local && !merged.changed) return false;
    this.upsert('chat', merged.row, { hlc: merged.hlc, field_hlc: JSON.stringify(merged.fieldHlc) });
    return true;
  }

  /** Chat heads that pointed at a message not here yet: taken now if it arrived, and still newer than the head here. */
  private resolveHeads(pending: { chatId: string; head: string; stamp: string }[]): void {
    for (const p of pending) {
      if (!this.exists('message', p.head)) continue;
      const chat = this.select('chat', p.chatId);
      if (!chat) continue;
      const fieldHlc = JSON.parse((chat['field_hlc'] as string) || '{}') as Record<string, string>;
      if (compareHlc(p.stamp, fieldHlc['headMessageId'] ?? (chat['hlc'] as string)) <= 0) continue;
      fieldHlc['headMessageId'] = p.stamp;
      this.db
        .prepare('UPDATE chat SET head_message_id = ?, field_hlc = ?, hlc = ? WHERE id = ?')
        .run(p.head, JSON.stringify(fieldHlc), maxHlc(chat['hlc'] as string, p.stamp), p.chatId);
    }
  }

  /** Delete wins: the row goes (with everything that cascades from it), and its tombstone keeps it gone. */
  private applyDelete(d: ChangeRow): boolean {
    const tbl = d.tbl;
    const local = this.select(tbl, d.id);
    if (!local) {
      const existing = this.tombstone(tbl, d.id);
      if (existing === null || compareHlc(d.hlc, existing) > 0) {
        this.db.prepare('INSERT OR REPLACE INTO tombstone (tbl, row_id, hlc) VALUES (?, ?, ?)').run(tbl, d.id, d.hlc);
      }
      return false;
    }
    if (tbl === 'location_path') {
      // This machine's own folder isn't another machine's to remove; and a
      // path set again after the removal stands.
      if (local['node_id'] === this.selfId() || compareHlc(local['hlc'] as string, d.hlc) > 0) return false;
    }
    this.clock.markDelete(d.hlc);
    this.db.prepare(`DELETE FROM ${tbl} WHERE ${keyWhere(tbl)}`).run(d.id);
    return true;
  }
}
