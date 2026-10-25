import type { DatabaseSync } from 'node:sqlite';
import { artifactTitleOk, isArtifactKind, isArtifactLanguage, isArtifactSlug, MAX_ARTIFACT_BYTES } from '@otherbench/core/domain/artifacts.js';
import { parseLiveSpec } from '@otherbench/core/domain/live-artifacts.js';
import { APP_FOLDER_NAME_MAX } from '@otherbench/core/domain/apps.js';
import { compareHlc, maxHlc } from '@otherbench/core/domain/hlc.js';
import { MAX_WORKFLOW_GRAPH_BYTES, workflowImportProblem } from '@otherbench/core/domain/media-workflows.js';
import { SYNC_TABLES, connectionSecretRef, isSha256, isSyncTable, mergeChatFields, mergeRow, type ChangeBatch, type ChangeRow, type SyncRow, type SyncTable } from '@otherbench/core/domain/sync.js';
import type { SyncApplyResult, SyncRepo } from '@otherbench/core/ports/store.js';
import { attachmentBound, bindHistoryAttachments, MAX_HISTORY_ATTACHMENT_BYTES } from '@otherbench/core/domain/attachment-binding.js';
import { attachmentRowShapeOk, bindToolImageParts, isToolImageMime, isToolVideoMime, MAX_TOOL_IMAGE_BYTES, MAX_TOOL_VIDEO_BYTES, type ToolImageRow } from '@otherbench/core/domain/tool-images.js';
import type { Part } from '@otherbench/core/types/messages.js';
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

/** A folder row as the app makes one: a name of 1-100 characters after trimming, and an integer position. */
function appFolderRowOk(row: SyncRow): boolean {
  const { id, name, sort_order: sortOrder } = row;
  if (typeof id !== 'string' || id.length === 0) return false;
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > APP_FOLDER_NAME_MAX) return false;
  return Number.isInteger(sortOrder);
}

/** A workflow row as an import makes one: the same size cap and `workflowProblem` checks, and never a built-in's id. */
function mediaWorkflowRowOk(row: SyncRow): boolean {
  const { id, name, media, graph, bindings, checkpoint } = row;
  if (typeof id !== 'string' || id.startsWith('builtin:')) return false;
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false;
  if (media !== 'image' && media !== 'video') return false;
  if (checkpoint != null && typeof checkpoint !== 'string') return false;
  if (typeof graph !== 'string' || typeof bindings !== 'string') return false;
  // The cap is on the text as stored, before anything is parsed.
  if (new TextEncoder().encode(graph).length > MAX_WORKFLOW_GRAPH_BYTES) return false;
  try {
    return workflowImportProblem(JSON.parse(graph), JSON.parse(bindings)) === null;
  } catch {
    return false;
  }
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

/** An artifact row as OtherBench makes one (Deck #900): a short id, a known kind, a short language. */
function artifactRowOk(row: SyncRow): boolean {
  return isArtifactSlug(row['slug']) && isArtifactKind(row['kind']) && languageOk(row['language']);
}

/** Longer than any declaration parseLiveSpec takes (32 KB canonical), with room for whitespace. */
const MAX_LIVE_TEXT = 64 * 1024;

/** A version's live declaration (spec 2026-10-12-live-artifacts): none, or one OtherBench would make, and only on an html version. */
function liveOk(row: SyncRow): boolean {
  const live = row['live'];
  if (live === null || live === undefined) return true;
  if (typeof live !== 'string' || live.length > MAX_LIVE_TEXT || row['kind'] !== 'html') return false;
  const parsed = parseLiveSpec(live);
  return parsed.ok && parsed.spec !== null;
}

/** Rewrites a valid `live` to the form OtherBench itself stores (names normalised, args and params filled in), so a peer's spelling never reaches the store. */
function canonicaliseLive(row: SyncRow): void {
  const live = row['live'];
  if (typeof live !== 'string') return;
  const parsed = parseLiveSpec(live);
  if (parsed.ok && parsed.spec !== null) row['live'] = JSON.stringify(parsed.spec);
}

/** A version row as OtherBench makes one: a one-line title, a whole number from 1, a known kind and maker, at most 1 MB, and a live declaration OtherBench could have made. */
function artifactVersionRowOk(row: SyncRow): boolean {
  const { title, number, content } = row;
  return (
    typeof title === 'string' && artifactTitleOk(title) &&
    typeof number === 'number' && Number.isInteger(number) && number >= 1 &&
    isArtifactKind(row['kind']) && languageOk(row['language']) &&
    (row['made_by'] === 'model' || row['made_by'] === 'user') &&
    typeof content === 'string' && Buffer.byteLength(content, 'utf8') <= MAX_ARTIFACT_BYTES &&
    liveOk(row)
  );
}

/** A file row that a batch wrote: its id, and the chat and message its row names. */
interface ArrivedFile {
  id: string;
  chatId: unknown;
  messageId: unknown;
}

/**
 * The attachment ids a stored message is still waiting for: every `pending`
 * mention in its parts (a user's image or file part, or an image reference in
 * a tool result). Nothing for parts that do not parse.
 */
function pendingMentions(partsJson: string): string[] {
  let parts: unknown;
  try {
    parts = JSON.parse(partsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parts)) return [];
  const waitingFor = (item: unknown): string | null => {
    if (typeof item !== 'object' || item === null) return null;
    const v = item as { pending?: unknown; attachmentId?: unknown };
    return v.pending === true && typeof v.attachmentId === 'string' ? v.attachmentId : null;
  };
  const ids: string[] = [];
  for (const part of parts as unknown[]) {
    const own = waitingFor(part);
    if (own !== null) ids.push(own);
    const result = typeof part === 'object' && part !== null ? (part as { type?: unknown; result?: unknown }) : null;
    if (result?.type !== 'tool-result' || !Array.isArray(result.result)) continue;
    for (const item of result.result as unknown[]) {
      const held = waitingFor(item);
      if (held !== null) ids.push(held);
    }
  }
  return ids;
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

  missingBlobs(): { id: string; sha256: string; size: number }[] {
    // Only a file bound to a message of its own chat is ever fetched or given a local blob.
    const rows = this.db
      .prepare(`SELECT a.id, a.sha256, a.size, a.mime, hm.role AS role FROM attachment a JOIN message hm ON hm.id = a.message_id WHERE a.storage_path = '' AND ${BOUND_ATTACHMENT_SQL} ORDER BY a.id`)
      .all() as { id: string; sha256: string; size: unknown; mime: unknown; role: unknown }[];
    // And only one whose row states a size a blob can be held to (what `attachmentRowOk` asks of a row on apply): an
    // older row may hold text or a fraction there, which no caller could cap a download by.
    // The cap is the one `attachmentRowOk` applied: a tool's video on a reply may be up to the video cap.
    const sized = (r: { size: unknown; mime: unknown; role: unknown }): boolean =>
      typeof r.size === 'number' && Number.isInteger(r.size) && r.size >= 0 && r.size <= (r.role === 'assistant' && isToolVideoMime(r.mime) ? MAX_TOOL_VIDEO_BYTES : MAX_HISTORY_ATTACHMENT_BYTES);
    return rows.filter(sized).filter((r) => isSha256(r.sha256)).map((r) => ({ id: r.id, sha256: r.sha256, size: r.size as number }));
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
    if (tbl === 'message') this.bindMessageImages(row, id, 'drop');
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
      const arrived: ArrivedFile[] = [];
      for (const u of upserts) {
        const outcome = u.tbl === 'chat' ? this.applyChat(u, pendingHeads) : this.applyRow(u);
        if (outcome) {
          result.applied++;
          result.written.push({ tbl: u.tbl, id: u.id });
          if (u.tbl === 'attachment') {
            result.attachments.push({ id: u.id, sha256: u.row['sha256'] as string });
            arrived.push({ id: u.id, chatId: u.row['chat_id'], messageId: u.row['message_id'] });
          }
        } else {
          result.skipped++;
        }
      }
      this.resolveHeads(pendingHeads);
      // Second phase: every message that came in this batch (or earlier) and names a file that has
      // only now arrived (or changed) is checked again against it, and verified or turned into a note.
      this.reverifyWaiting(arrived);
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
      case 'app':
        if (row['default_profile_id'] != null && !this.exists('profile', row['default_profile_id'])) row['default_profile_id'] = null;
        if (row['workspace_location_id'] != null && !this.exists('location', row['workspace_location_id'])) {
          row['workspace_location_id'] = null;
          row['workspace_subpath'] = null;
        }
        // Not a foreign key (migration 029): a link to a project that isn't here is written as none rather than
        // refusing the app; the link comes back the next time the app itself changes.
        if (row['linked_project_id'] != null && !this.exists('project', row['linked_project_id'])) row['linked_project_id'] = null;
        return true;
      case 'project_memory':
        return this.exists('project', row['project_id']);
      case 'global_memory':
        // Only the two rows OtherBench writes; anything else would fail the table's CHECK.
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
      if (!this.attachmentRowOk(row)) return false;
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
    if (u.tbl === 'app_folder' && !appFolderRowOk(row)) return false;
    // `folder_id` is not a foreign key (migration 032) and is never checked against the folders here: rows arrive in no fixed order.
    if (u.tbl === 'app' && row['folder_id'] != null && typeof row['folder_id'] !== 'string') return false;
    // A workflow is sent to a generation backend: only what an import would have accepted.
    if (u.tbl === 'media_workflow' && !mediaWorkflowRowOk(row)) return false;
    // Artifact rows reach the model's prompt and the viewer: only what OtherBench itself could have made.
    if (u.tbl === 'artifact' && !artifactRowOk(row)) return false;
    if (u.tbl === 'artifact_version') {
      if (!artifactVersionRowOk(row)) return false;
      canonicaliseLive(row);
    }
    // A machine's own folder for a location is its to set; another machine
    // may only fill it in where there's none yet (adopting a location).
    if (u.tbl === 'location_path' && row['node_id'] === this.selfId() && local) return false;
    const tomb = this.tombstone(u.tbl, u.id);
    if (mergeRow((local?.['hlc'] as string | undefined) ?? null, u.hlc, tomb, u.tbl === 'location_path') === 'skip') return false;
    if (!this.parentsPresent(u.tbl, row)) return false;
    if (u.tbl === 'message') this.bindMessageImages(row, u.id, 'hold');
    // Columns only this machine sets get their defaults on a new row.
    const insertOnly: Record<string, unknown> = u.tbl === 'attachment' ? { storage_path: '' } : {};
    this.upsert(u.tbl, row, { hlc: u.hlc }, insertOnly);
    if (tomb !== null) this.db.prepare('DELETE FROM tombstone WHERE tbl = ? AND row_id = ?').run(u.tbl, u.id);
    return true;
  }

  /**
   * An attachment row as OtherBench itself makes one (modelled on `artifactRowOk` and
   * `artifactVersionRowOk` above): the shape core checks for every file, a size
   * within the upload cap, and, for a file on an assistant reply (a tool's image),
   * a raster type within the per-image cap, or a video type within the per-video cap. A user's upload keeps its own rules.
   */
  private attachmentRowOk(row: SyncRow): boolean {
    const holder = this.db.prepare('SELECT role FROM message WHERE id = ?').get(row['message_id'] as string) as { role: string } | undefined;
    const onReply = holder?.role === 'assistant';
    // A tool's video may be larger than an upload; the per-type caps below hold a reply's file to its own.
    if (!attachmentRowShapeOk({ id: row['id'], filename: row['filename'], mime: row['mime'], size: row['size'] }, onReply ? MAX_TOOL_VIDEO_BYTES : MAX_HISTORY_ATTACHMENT_BYTES)) return false;
    if (onReply) {
      const size = row['size'] as number;
      return (isToolImageMime(row['mime']) && size <= MAX_TOOL_IMAGE_BYTES) || (isToolVideoMime(row['mime']) && size <= MAX_TOOL_VIDEO_BYTES);
    }
    return true;
  }

  /** The attachment row `id` as the binding checks read it: every field exactly as stored, null when there is none. */
  private fileFacts(id: string): ToolImageRow | null {
    const a = this.select('attachment', id);
    return a ? ({ chatId: a['chat_id'], messageId: a['message_id'], mime: a['mime'], size: a['size'] } as ToolImageRow) : null;
  }

  /** A message's parts with their files checked (see `bindMessageImages`); the same array when nothing changed. */
  private boundParts(chatId: string, id: string, parts: Part[], missing: 'hold' | 'drop'): Part[] {
    // Images a tool result refers to: the file must be here and be this chat's and this message's.
    const toolBound = bindToolImageParts(parts, chatId, id, (attachmentId) => this.fileFacts(attachmentId), missing);
    // Images and files the user sent: a file that is here must be this chat's and bound; one that is not here
    // yet is marked pending (not replayable) when `missing` is 'hold', and a note otherwise.
    const [carrier] = bindHistoryAttachments(
      [{ id, chatId, parentId: null, role: 'user', parts: toolBound, status: 'complete', error: null, producedBy: null, createdAt: 0 }],
      (attachmentId) => {
        const a = this.select('attachment', attachmentId);
        if (a === null) return missing === 'hold' ? 'pending' : false;
        return a['chat_id'] === chatId && this.isBound(a['chat_id'], a['message_id']);
      }
    );
    const bound = carrier!.parts;
    return JSON.stringify(bound) === JSON.stringify(parts) ? parts : bound;
  }

  /**
   * A synced message's references to files are checked against the files here
   * and no reference passes on a missing file or a null field. A file that has
   * not arrived (`'hold'`, on apply) leaves the reference marked `pending`,
   * which nothing replays or serves; `reverifyMessage` clears the mark, or
   * turns the reference into a note, when the file arrives. On a read or an
   * offer (`'drop'`) it is a note.
   */
  private bindMessageImages(row: SyncRow, id: string, missing: 'hold' | 'drop'): void {
    const chatId = row['chat_id'];
    if (typeof row['parts'] !== 'string' || typeof chatId !== 'string') return;
    let parts: Part[];
    try {
      parts = JSON.parse(row['parts']) as Part[];
    } catch {
      return;
    }
    if (!Array.isArray(parts)) return;
    const bound = this.boundParts(chatId, id, parts, missing);
    if (bound !== parts) row['parts'] = JSON.stringify(bound);
  }

  /**
   * The messages to check again now that `files` have arrived or changed: the
   * message each file was sent in, and every other message of the file's own
   * chat that holds a pending mention of it (an edit-and-resend sibling names
   * the same file, which stays on its first message). One pass per chat over
   * the messages that hold any pending mark at all (a cheap text test on the
   * stored parts, then a parse), so the work is bounded by that chat. A
   * message of another chat is never looked at: no file of this chat can
   * verify it, and every read turns its reference into a note.
   */
  private reverifyWaiting(files: ArrivedFile[]): void {
    const messages = new Set<string>();
    const byChat = new Map<string, Set<string>>();
    for (const file of files) {
      if (typeof file.messageId === 'string') messages.add(file.messageId);
      if (typeof file.chatId !== 'string') continue;
      const ids = byChat.get(file.chatId) ?? new Set<string>();
      byChat.set(file.chatId, ids.add(file.id));
    }
    const waiting = this.db.prepare(`SELECT id, parts FROM message WHERE chat_id = ? AND instr(parts, '"pending"') > 0`);
    for (const [chatId, ids] of byChat) {
      for (const row of waiting.all(chatId) as { id: string; parts: string }[]) {
        if (pendingMentions(row.parts).some((attachmentId) => ids.has(attachmentId))) messages.add(row.id);
      }
    }
    for (const messageId of messages) this.reverifyMessage(messageId);
  }

  /** Checks a stored message's files again (a file of its has just arrived). The stamp is untouched: nothing here is a change to send. */
  private reverifyMessage(messageId: string): void {
    const message = this.select('message', messageId);
    if (!message || typeof message['parts'] !== 'string' || typeof message['chat_id'] !== 'string') return;
    let parts: Part[];
    try {
      parts = JSON.parse(message['parts']) as Part[];
    } catch {
      return;
    }
    if (!Array.isArray(parts)) return;
    const bound = this.boundParts(message['chat_id'], messageId, parts, 'hold');
    if (bound !== parts) this.db.prepare('UPDATE message SET parts = ?, search_text = ? WHERE id = ?').run(JSON.stringify(bound), deriveSearchText(bound), messageId);
  }

  private applyChat(u: Extract<ChangeRow, { op: 'upsert' }>, pendingHeads: { chatId: string; head: string; stamp: string }[]): boolean {
    // As in applyRow: the change's id and the row's own key must agree.
    if (rowKey('chat', u.row) !== u.id) return false;
    if (this.tombstone('chat', u.id) !== null) return false;
    const local = this.select('chat', u.id);
    const accept = (field: string, row: SyncRow): boolean => {
      if (field === 'profileId') return this.exists('profile', row['profile_id']);
      if (field === 'projectId') return row['project_id'] == null || this.exists('project', row['project_id']);
      // Not a foreign key (migration 029), but a chat stays out of an app that isn't here yet and takes it once it is.
      if (field === 'appId') return row['app_id'] == null || this.exists('app', row['app_id']);
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
