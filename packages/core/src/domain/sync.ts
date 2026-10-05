import { compareHlc, maxHlc } from './hlc.js';

/**
 * What syncs between paired machines and how conflicts resolve (v2 spec §4,
 * plan Task 50). Pure: the SQLite sync repo applies these rules to rows.
 */

/** Synced tables, parents before children: the order a batch is applied in. */
export const SYNC_TABLES = [
  'location',
  'location_path',
  'connection',
  'model',
  'profile',
  'project',
  'project_memory',
  'chat',
  'message',
  'attachment',
  'usage',
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

/**
 * The SecretStore reference a connection's API key is kept under, always
 * derived from its id: a synced row can't name another secret to be read
 * or overwritten through it.
 */
export function connectionSecretRef(connectionId: string): string {
  return `conn:${connectionId}`;
}

/** A blob's name on disk is its SHA-256: anything else is refused before it reaches a path. */
export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isSyncTable(t: string): t is SyncTable {
  return (SYNC_TABLES as readonly string[]).includes(t);
}

/** A row as it travels: its columns (`hlc` and `field_hlc` carried separately). */
export type SyncRow = Record<string, unknown>;

export type ChangeRow =
  | {
      tbl: SyncTable;
      id: string;
      op: 'upsert';
      hlc: string;
      row: SyncRow;
      /** chat only: the stamp of each field's last change. */
      fieldHlc?: Record<string, string>;
      /** connection only: its API key, sent inside the TLS session unless the connection keeps it home. */
      secret?: string;
    }
  | { tbl: SyncTable; id: string; op: 'delete'; hlc: string };

export interface ChangeBatch {
  rows: ChangeRow[];
  /** The cursor to ask from next time. */
  nextSeq: number;
  more: boolean;
}

/**
 * Whether an incoming upsert of a whole row should be written. Delete wins:
 * a row deleted here stays deleted, whatever arrives later -- except one that
 * can legitimately be created again under the same key (`recreatable`, a
 * location path), where the newer of the delete and the upsert wins.
 * Otherwise the newer stamp wins; an equal one is the same change come back.
 */
export function mergeRow(
  localHlc: string | null,
  incomingHlc: string,
  tombstoneHlc: string | null,
  recreatable = false
): 'write' | 'skip' {
  if (tombstoneHlc !== null) {
    if (!recreatable || compareHlc(incomingHlc, tombstoneHlc) <= 0) return 'skip';
  }
  if (localHlc === null) return 'write';
  return compareHlc(incomingHlc, localHlc) > 0 ? 'write' : 'skip';
}

/**
 * A chat's fields, each with the columns it covers. Two machines editing
 * different fields of one chat (one renames it, the other pins it) both win.
 * `created_at` never changes; `updated_at` takes the later of the two.
 */
export const CHAT_FIELDS: Record<string, string[]> = {
  title: ['title'],
  profileId: ['profile_id'],
  headMessageId: ['head_message_id'],
  workspace: ['workspace_location_id', 'workspace_subpath', 'workspace_root', 'workspace_node'],
  runsOn: ['runs_on'],
  pinned: ['pinned'],
  archivedAt: ['archived_at'],
  autoMode: ['auto_mode'],
  projectId: ['project_id'],
  memoryCursor: ['memory_cursor'],
  memoryExcluded: ['memory_excluded'],
  sortOrder: ['sort_order'],
};

export interface ChatSide {
  row: SyncRow;
  hlc: string;
  fieldHlc: Record<string, string>;
}

/** A field's stamp: its own, or the row's for a field never stamped on its own (a row from before field stamps). */
function fieldStamp(side: ChatSide, field: string): string {
  return side.fieldHlc[field] ?? side.hlc;
}

/**
 * Merges an incoming chat into the local one field by field, the newer
 * stamp winning each. `accept(field, row)` can refuse a field whose value
 * can't be applied yet (a head message that hasn't arrived): it keeps the
 * local value AND the local stamp, so the same change is taken when it comes
 * again. The merged row's stamp is the newest field stamp kept.
 */
export function mergeChatFields(
  local: ChatSide | null,
  incoming: ChatSide,
  accept: (field: string, row: SyncRow) => boolean = () => true
): ChatSide & { changed: boolean } {
  if (!local) {
    const row = { ...incoming.row };
    const fieldHlc: Record<string, string> = {};
    for (const field of Object.keys(CHAT_FIELDS)) {
      if (accept(field, incoming.row)) {
        fieldHlc[field] = fieldStamp(incoming, field);
      } else {
        // Older than any real stamp, so the value is taken when it can be.
        fieldHlc[field] = '';
        for (const col of CHAT_FIELDS[field]!) row[col] = null;
      }
    }
    const hlc = Object.values(fieldHlc).reduce((a, b) => maxHlc(a, b), '');
    return { row, fieldHlc, hlc: hlc || incoming.hlc, changed: true };
  }
  const row = { ...local.row };
  const fieldHlc = { ...local.fieldHlc };
  let changed = false;
  for (const [field, cols] of Object.entries(CHAT_FIELDS)) {
    const theirs = fieldStamp(incoming, field);
    if (compareHlc(theirs, fieldStamp(local, field)) <= 0) continue;
    if (!accept(field, incoming.row)) continue;
    for (const col of cols) row[col] = incoming.row[col] ?? null;
    fieldHlc[field] = theirs;
    changed = true;
  }
  const updatedLocal = Number(local.row['updated_at'] ?? 0);
  const updatedIncoming = Number(incoming.row['updated_at'] ?? 0);
  if (updatedIncoming > updatedLocal) {
    row['updated_at'] = updatedIncoming;
    changed = true;
  }
  const hlc = Object.values(fieldHlc).reduce((a, b) => maxHlc(a, b), local.hlc);
  return { row, fieldHlc, hlc, changed };
}
