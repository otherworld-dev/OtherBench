import type { DatabaseSync } from 'node:sqlite';
import type { MessageRepo } from '@grunt/core/ports/store.js';
import type {
  CanonMessage,
  EngineMeta,
  MessageStatus,
  Part,
  ProducedBy,
  Role,
  SerializedError,
} from '@grunt/core/types/messages.js';
import { fromJson, fromJsonNullable, toJson, toJsonNullable } from './util.js';
import { selfIdOf } from './nodes.js';
import { clockOf, type SyncClock } from './clock.js';

// `message` is the one tree-shaped table, so it does not use SqliteCrudRepo
// (see the comment there): `children`/`roots`/`pathToRoot` are graph queries,
// and both write paths have to maintain `search_text` alongside `parts`.
//
// The error policy below is not local taste -- it is pinned by the shared
// contract suite in packages/core/src/testing/store-contract.ts, which runs
// unmodified against both this adapter and InMemoryStore:
//   - create(): duplicate id throws (the PRIMARY KEY does this for free)
//   - get(): null for an unknown id
//   - updateParts()/updateStatus(): throw when the id does not exist
//   - pathToRoot(): returns [] for an unknown id, it does NOT throw

/** The columns of `message` that map onto CanonMessage, in a fixed order. */
const COLUMNS = 'id, chat_id, parent_id, role, parts, status, error, produced_by, created_at, engine_meta, kept_at, origin_node';

/**
 * Hard cap on how many ancestor hops `pathToRoot`'s recursive CTE will
 * follow. This is a backstop against cycles, not a realistic limit: SQLite
 * enforces `parent_id` foreign keys only *after* an INSERT completes, so a
 * self-reference (`parent_id = id`) satisfies the constraint (the row
 * already exists by the time the check runs) even with `PRAGMA foreign_keys
 * = ON` -- `create()` below rejects that specific case explicitly, but a
 * longer cycle (A -> B -> A) could still be introduced by something other
 * than this repo's `create()`, e.g. a raw-SQL data import or future
 * reparenting code. Without a cap, `ORDER BY depth DESC` forces SQLite to
 * fully materialise the recursive CTE before any row can be returned, so a
 * cycle recurses forever and hangs this synchronous, single-threaded
 * process.
 *
 * 10,000 is chosen to sit far above any real conversation: it is roughly
 * two orders of magnitude beyond a plausible single-lineage chat depth (a
 * conversation with thousands of sequential turns is already impractical to
 * scroll through in the UI long before it gets anywhere near this), while
 * still resolving in single-digit milliseconds even when it IS hit (a
 * 2-node cycle capped at this depth returns ~10k rows in ~10ms -- measured
 * while choosing this value). So genuine conversations never notice the
 * cap, but a cycle is bounded rather than unbounded.
 */
const MAX_PATH_DEPTH = 10_000;

/**
 * The FTS5 sync target. SQLite triggers cannot conveniently pick the `text`
 * parts out of the JSON `parts` array, so the repository derives the indexed
 * text on every write and the triggers index that plain column instead.
 * Non-text parts (images, tool calls, tool results) are deliberately excluded
 * so that e.g. a file path in a tool-call argument is not searchable prose.
 */
export function deriveSearchText(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * Turns a raw user search-box query into a safe FTS5 `MATCH` expression, or
 * `null` if there is nothing to search for.
 *
 * FTS5's default query syntax is not plain text -- `"`, unbalanced `(`/`)`,
 * a leading `-` (the NOT-prefix operator), a dangling boolean operator
 * (`AND`/`OR`/`NOT`) and `col:` (column-filter syntax) are all *syntax*
 * there, not literal characters. Every one of those is something a person
 * can type into an ordinary search box without meaning anything special by
 * it, and passing the raw string straight to `MATCH` throws
 * (`fts5: syntax error ...`, `unterminated string`, `no such column`) for
 * exactly those inputs.
 *
 * The fix is to quote: split on whitespace and wrap each token in double
 * quotes (doubling any embedded `"`, FTS5's own escape for a literal quote
 * inside a string literal). An FTS5 string literal is always a phrase, never
 * an operator, so `col:banana` becomes a phrase search for the tokens `col`
 * then `banana` instead of a column filter, `-banana` searches for the word
 * `banana` instead of negating the (nonexistent) preceding term, and a lone
 * `"` becomes a phrase search for a literal quote character instead of an
 * unterminated string. Multiple quoted phrases separated by whitespace are
 * ANDed by FTS5's default query syntax, so `banana AND` becomes "message
 * contains both banana and AND" -- exactly what a user typing a dangling
 * operator meant -- rather than a syntax error.
 */
function toFtsMatchExpression(query: string): string | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}

/** True for the error node:sqlite throws when a prepared statement fails at the SQLite level. */
function isSqliteError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR';
}

function fromRow(row: Record<string, unknown>): CanonMessage {
  const message: CanonMessage = {
    id: row.id as string,
    chatId: row.chat_id as string,
    parentId: row.parent_id as string | null,
    role: row.role as Role,
    parts: fromJson<Part[]>(row.parts as string),
    status: row.status as MessageStatus,
    error: fromJsonNullable<SerializedError>(row.error as string | null),
    producedBy: fromJsonNullable<ProducedBy>(row.produced_by as string | null),
    createdAt: row.created_at as number,
  };
  // Omitted (not null) when unset, so rows without engine state keep their
  // existing shape -- see CanonMessage.engineMeta.
  const engineMeta = fromJsonNullable<EngineMeta>((row.engine_meta as string | null) ?? null);
  if (engineMeta) message.engineMeta = engineMeta;
  const keptAt = (row.kept_at as number | null | undefined) ?? null;
  if (keptAt !== null) message.keptAt = keptAt;
  const originNode = (row.origin_node as string | null | undefined) ?? null;
  if (originNode !== null) message.originNode = originNode;
  return message;
}

export class SqliteMessageRepo implements MessageRepo {
  /** `selfId` is this machine's node id, the default `originNode`. */
  constructor(
    private readonly db: DatabaseSync,
    private readonly selfId: () => string = selfIdOf(db),
    private readonly clock: SyncClock = clockOf(db, selfId)
  ) {}

  create(m: Omit<CanonMessage, 'createdAt'> & { createdAt?: number }): CanonMessage {
    if (m.parentId === m.id) {
      // Caught here, not left to the FK constraint: SQLite checks
      // `parent_id` (an immediate, non-deferred FK) only after the INSERT
      // completes, by which point the new row already exists -- so a
      // self-reference satisfies the constraint instead of violating it,
      // and would go on to send `pathToRoot` into an unbounded recursion
      // (see MAX_PATH_DEPTH above).
      throw new Error(`message: parentId cannot equal id (self-referencing message): ${m.id}`);
    }
    const full: CanonMessage = { ...m, originNode: m.originNode ?? this.selfId(), createdAt: m.createdAt ?? Date.now() };
    this.db
      .prepare(
        `INSERT INTO message (${COLUMNS}, search_text, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        full.id,
        full.chatId,
        full.parentId,
        full.role,
        toJson(full.parts),
        full.status,
        toJsonNullable(full.error),
        toJsonNullable(full.producedBy),
        full.createdAt,
        toJsonNullable(full.engineMeta ?? null),
        full.keptAt ?? null,
        full.originNode ?? null,
        deriveSearchText(full.parts),
        this.clock.stamp()
      );
    return full;
  }

  get(id: string): CanonMessage | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM message WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? fromRow(row) : null;
  }

  // `id` breaks ties so that messages sharing a createdAt (same-millisecond
  // inserts, which a compare turn produces routinely) still come back in a
  // stable order rather than whatever the query planner happens to yield.
  children(parentId: string): CanonMessage[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM message WHERE parent_id = ? ORDER BY created_at ASC, id ASC`)
      .all(parentId) as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  roots(chatId: string): CanonMessage[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM message
         WHERE chat_id = ? AND parent_id IS NULL
         ORDER BY created_at ASC, id ASC`
      )
      .all(chatId) as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  /** Walks parent links upward, then reverses via `depth` so callers get root -> leaf. */
  pathToRoot(messageId: string): CanonMessage[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE ancestry(id, chat_id, parent_id, role, parts, status, error, produced_by, created_at, engine_meta, kept_at, origin_node, depth) AS (
           SELECT id, chat_id, parent_id, role, parts, status, error, produced_by, created_at, engine_meta, kept_at, origin_node, 0
             FROM message WHERE id = ?
           UNION ALL
           SELECT m.id, m.chat_id, m.parent_id, m.role, m.parts, m.status, m.error, m.produced_by, m.created_at, m.engine_meta, m.kept_at, m.origin_node, a.depth + 1
             FROM message m JOIN ancestry a ON m.id = a.parent_id
            WHERE a.depth < ${MAX_PATH_DEPTH}
         )
         SELECT ${COLUMNS} FROM ancestry ORDER BY depth DESC`
      )
      .all(messageId) as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  updateParts(id: string, parts: Part[]): void {
    const result = this.db
      .prepare(`UPDATE message SET parts = ?, search_text = ? WHERE id = ?`)
      .run(toJson(parts), deriveSearchText(parts), id);
    if (Number(result.changes) === 0) {
      throw new Error(`message: not found: ${id}`);
    }
  }

  // `error` omitted means "clear it" rather than "leave it": a message moving
  // to `complete` after a failed attempt must not keep the stale error.
  updateStatus(id: string, status: MessageStatus, error?: SerializedError | null): void {
    const result = this.db
      .prepare(`UPDATE message SET status = ?, error = ?, hlc = ? WHERE id = ?`)
      .run(status, toJsonNullable(error ?? null), this.clock.stamp(), id);
    if (Number(result.changes) === 0) {
      throw new Error(`message: not found: ${id}`);
    }
    if (status !== 'streaming') {
      // The files of a reply (a tool's screenshots) are rows made while it was still
      // streaming, so they were logged before the message could be sent and a peer
      // had to turn them down. Now that the message follows, they do too: logged
      // again, after it (the old entries go first, so their place in the log is
      // behind the message's, even when a batch ends between the two).
      this.db.prepare(`DELETE FROM change_log WHERE tbl = 'attachment' AND row_id IN (SELECT id FROM attachment WHERE message_id = ?)`).run(id);
      this.db.prepare(`INSERT INTO change_log (tbl, row_id, op) SELECT 'attachment', id, 'upsert' FROM attachment WHERE message_id = ?`).run(id);
    }
  }

  listByStatus(status: MessageStatus): CanonMessage[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM message WHERE status = ? ORDER BY created_at ASC, id ASC`)
      .all(status) as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  updateEngineMeta(id: string, meta: EngineMeta): void {
    const result = this.db.prepare(`UPDATE message SET engine_meta = ?, hlc = ? WHERE id = ?`).run(toJson(meta), this.clock.stamp(), id);
    if (Number(result.changes) === 0) {
      throw new Error(`message: not found: ${id}`);
    }
  }

  markKept(id: string, at: number): void {
    const result = this.db.prepare(`UPDATE message SET kept_at = ?, hlc = ? WHERE id = ?`).run(at, this.clock.stamp(), id);
    if (Number(result.changes) === 0) {
      throw new Error(`message: not found: ${id}`);
    }
  }

  latestId(chatId: string): string | null {
    const row = this.db.prepare('SELECT id FROM message WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(chatId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  latestBySession(chatId: string, sessionId: string): CanonMessage | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM message
          WHERE chat_id = ? AND engine_meta IS NOT NULL AND json_extract(engine_meta, '$.sessionId') = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`
      )
      .get(chatId, sessionId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  searchText(query: string, limit: number, offset = 0): { messageId: string; chatId: string; snippet: string }[] {
    const match = toFtsMatchExpression(query);
    if (match === null) return [];

    let rows: Record<string, unknown>[];
    try {
      rows = this.db
        .prepare(
          `SELECT m.id AS id, m.chat_id AS chat_id,
                  snippet(message_fts, 0, '[', ']', '...', 12) AS snippet
             FROM message_fts f
             JOIN message m ON m.rowid = f.rowid
            WHERE message_fts MATCH ?
            ORDER BY rank, m.rowid
            LIMIT ? OFFSET ?`
        )
        .all(match, limit, offset) as Record<string, unknown>[];
    } catch (err) {
      // Secondary guard, not the primary defence (that's the quoting above):
      // an FTS5 edge case we haven't enumerated should degrade to "no
      // results" rather than crash a search box, but only for an actual
      // SQLite-level failure -- anything else (a real bug) still propagates.
      if (isSqliteError(err)) return [];
      throw err;
    }
    return rows.map((r) => ({
      messageId: r.id as string,
      chatId: r.chat_id as string,
      snippet: r.snippet as string,
    }));
  }
}
