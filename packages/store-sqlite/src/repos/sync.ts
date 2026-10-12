import type { DatabaseSync } from 'node:sqlite';
import { artifactTitleOk, isArtifactKind, isArtifactLanguage, isArtifactSlug, MAX_ARTIFACT_BYTES } from '@grunt/core/domain/artifacts.js';
import { compareHlc, maxHlc } from '@grunt/core/domain/hlc.js';
import { SYNC_TABLES, connectionSecretRef, isSha256, isSyncTable, mergeChatFields, mergeRow, type ChangeBatch, type ChangeRow, type SyncRow, type SyncTable } from '@grunt/core/domain/sync.js';
import type { SyncApplyResult, SyncRepo } from '@grunt/core/ports/store.js';
import { attachmentBound, bindHistoryAttachments } from '@grunt/core/domain/attachment-binding.js';
import { bindToolImageParts } from '@grunt/core/domain/tool-images.js';
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

/**
 * THE rule for a file that may travel: an attachment is bound when it was sent
 * in a message, that message exists, and the message belongs to the attachment's
 * own chat (which exists). Every path that offers a file row, offers its bytes,
 * asks for its bytes or accepts its row uses this (SQL here, `isBound` for a row
 * being applied), so none can disagree about what a file is bound to. The JS
 * form is core's `attachmentBound`; a test proves the two agree.
 */
export const BOUND_ATTACHMENT_SQL = `EXISTS (SELECT 1 FROM message m WHERE m.id = a.message_id AND m.chat_id = a.chat_id)`;

/** The facts of an attachment that never change once it is sent: a peer can't re-point or swap one. */
const ATTACHMENT_FIXED_FACTS = ['chat_id', 'sha256', 'mime', 'size'] as const;

/** Each table's key columns; most are keyed on `id`. */
const KEYS: Partial<Record<SyncTable, string[]>> = {
  location_path: ['location_id', 'node_id'],
  project_memory: ['project_id'],
  global_memory: ['key'],
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

/** A code artifact's language, or none. */
const languageOk = (language: unknown): boolean => language === null || language === undefined || isArtifactLanguage(language);

/** An artifact row as Grunt makes one (Deck #900): a short id, a known kind, a short language. */
function artifactRowOk(row: SyncRow): boolean {
  return isArtifactSlug(row['slug']) && isArtifactKind(row['kind']) && languageOk(row['language']);
}

/** A version row as Grunt makes one: a one-line title, a whole number from 1, a known kind and maker, at most 1 MB. */
function artifactVersionRowOk(row: SyncRow): boolean {
  const { title, number, content } = row;
  return (
    typeof title === 'string' && artifactTitleOk(title) &&
    typeof number === 'number' && Number.isInteger(number) && number >= 1 &&
    isArtifactKind(row['kind']) && languageOk(row['language']) &&
    (row['made_by'] === 'model' || row['made_by'] === 'user') &&
    typeof content === 'string' && Buffer.byteLength(content, 'utf8') <= MAX_ARTIFACT_BYTES
  );
}

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
    // Only a file bound to a message of its own chat is ever fetched or given a local blob.
    const rows = this.db.prepare(`SELECT a.id, a.sha256 FROM attachment a WHERE a.storage_path = '' AND ${BOUND_ATTACHMENT_SQL} ORDER BY a.id`).all() as { id: string; sha256: string }[];
    return rows.filter((r) => isSha256(r.sha256));
  }

  isSentBlob(sha256: string): boolean {
    if (!isSha256(sha256)) return false;
    return this.db.prepare(`SELECT 1 FROM attachment a WHERE a.sha256 = ? AND ${BOUND_ATTACHMENT_SQL} LIMIT 1`).get(sha256) !== undefined;
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

  /** `BOUND_ATTACHMENT_SQL` for a row that is being offered or applied (it may not be in the table yet). */
  private isBound(chatId: unknown, messageId: unknown): boolean {
    if (typeof chatId !== 'string' || typeof messageId !== 'string') return false;
    const message = this.db.prepare('SELECT chat_id FROM message WHERE id = ?').get(messageId) as { chat_id: string } | undefined;
    return attachmentBound({ chatId, messageId }, message?.chat_id ?? null);
  }

  /** Whether message `id` is one a peer is sent (everything but a reply still streaming). */
  private messageOfferable(id: unknown): boolean {
    if (typeof id !== 'string') return false;
    const message = this.db.prepare('SELECT status FROM message WHERE id = ?').get(id) as { status: string } | undefined;
    return message !== undefined && message.status !== 'streaming';
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
        // Not yet: a reply still streaming is logged again when it stops (the trigger).
        if (e.tbl === 'message' && row['status'] === 'streaming') continue;
        // A file is offered only bound to a message of its own chat, and only once that message can be
        // offered itself (a peer turns a file down when its message is missing). A file of a reply that
        // is still streaming is logged again, behind the message, when the reply stops (`updateStatus`).
        if (e.tbl === 'attachment' && !(this.isBound(row['chat_id'], row['message_id']) && this.messageOfferable(row['message_id']))) continue;
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
    // Offered as it would be accepted: a message's references to files are checked here too, whatever was stored before.
    if (tbl === 'message') this.bindMessageImages(row, id);
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
      case 'global_memory':
        // Only the two rows Grunt writes; anything else would fail the table's CHECK.
        return row['key'] === 'about' || row['key'] === 'note';
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
    if (u.tbl === 'attachment') {
      // A file travels only bound to a message of its own chat.
      if (!this.isBound(row['chat_id'], row['message_id'])) return false;
      // A file stays what it was, in the chat and on the message it was sent with:
      // another machine can't re-point an attachment id it knows at a different chat
      // or reply, or swap its content or type, which would make any message's
      // reference to it show that file. Its extracted text (what a model that can't
      // take images is sent instead of the file) is set once: it may arrive where there
      // was none, and is never changed after. (Last-writer-wins applies to its name only.)
      if (local) {
        if (ATTACHMENT_FIXED_FACTS.some((k) => local[k] !== row[k])) return false;
        if (local['extracted_text'] != null && local['extracted_text'] !== row['extracted_text']) return false;
        if (local['message_id'] != null && local['message_id'] !== row['message_id']) return false;
      }
      // Delete wins for good: an id that was removed is never made again with a new binding.
      if (this.tombstone('attachment', u.id) !== null) return false;
    }
    // Artifact rows reach the model's prompt and the viewer: only what Grunt itself could have made.
    if (u.tbl === 'artifact' && !artifactRowOk(row)) return false;
    if (u.tbl === 'artifact_version' && !artifactVersionRowOk(row)) return false;
    // A machine's own folder for a location is its to set; another machine
    // may only fill it in where there's none yet (adopting a location).
    if (u.tbl === 'location_path' && row['node_id'] === this.selfId() && local) return false;
    const tomb = this.tombstone(u.tbl, u.id);
    if (mergeRow((local?.['hlc'] as string | undefined) ?? null, u.hlc, tomb, u.tbl === 'location_path') === 'skip') return false;
    if (!this.parentsPresent(u.tbl, row)) return false;
    if (u.tbl === 'message') this.bindMessageImages(row, u.id);
    // Columns only this machine sets get their defaults on a new row.
    const insertOnly: Record<string, unknown> = u.tbl === 'attachment' ? { storage_path: '' } : {};
    this.upsert(u.tbl, row, { hlc: u.hlc }, insertOnly);
    if (tomb !== null) this.db.prepare('DELETE FROM tombstone WHERE tbl = ? AND row_id = ?').run(u.tbl, u.id);
    return true;
  }

  /**
   * A synced message's tool results can't make a file of another chat appear:
   * a reference to an attachment that is here but belongs to another chat or
   * reply, and any image that isn't a reference, becomes a text note. A
   * reference to a file that hasn't arrived yet stays (files follow their
   * message); every read checks the binding again.
   */
  private bindMessageImages(row: SyncRow, id: string): void {
    const chatId = row['chat_id'];
    if (typeof row['parts'] !== 'string' || typeof chatId !== 'string') return;
    let parts: Part[];
    try {
      parts = JSON.parse(row['parts']) as Part[];
    } catch {
      return;
    }
    if (!Array.isArray(parts)) return;
    // Images a tool result refers to: the file here must be this chat's and this message's.
    const toolBound = bindToolImageParts(
      parts,
      chatId,
      id,
      (attachmentId) => {
        const a = this.select('attachment', attachmentId);
        return a ? { chatId: String(a['chat_id']), messageId: typeof a['message_id'] === 'string' ? a['message_id'] : null, mime: String(a['mime']) } : null;
      },
      'keep'
    );
    // Images and files the user sent: a file that is here must be this chat's (one that has not arrived yet is checked when it is read).
    const [carrier] = bindHistoryAttachments(
      [{ id, chatId, parentId: null, role: 'user', parts: toolBound, status: 'complete', error: null, producedBy: null, createdAt: 0 }],
      (attachmentId) => {
        const a = this.select('attachment', attachmentId);
        // A file that hasn't arrived is left to the read-time check; one that is here must be this chat's and bound.
        return a === null || (a['chat_id'] === chatId && this.isBound(a['chat_id'], a['message_id']));
      }
    );
    const bound = carrier!.parts;
    if (bound !== parts) row['parts'] = JSON.stringify(bound);
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
