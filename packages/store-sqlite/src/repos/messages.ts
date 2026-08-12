import type { DatabaseSync } from 'node:sqlite';
import type { MessageRepo } from '@grunt/core/ports/store.js';
import type {
  CanonMessage,
  MessageStatus,
  Part,
  ProducedBy,
  Role,
  SerializedError,
} from '@grunt/core/types/messages.js';
import { fromJson, fromJsonNullable, toJson, toJsonNullable } from './util.js';

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
const COLUMNS = 'id, chat_id, parent_id, role, parts, status, error, produced_by, created_at';

/**
 * The FTS5 sync target. SQLite triggers cannot conveniently pick the `text`
 * parts out of the JSON `parts` array, so the repository derives the indexed
 * text on every write and the triggers index that plain column instead.
 * Non-text parts (images, tool calls, tool results) are deliberately excluded
 * so that e.g. a file path in a tool-call argument is not searchable prose.
 */
function deriveSearchText(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function fromRow(row: Record<string, unknown>): CanonMessage {
  return {
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
}

export class SqliteMessageRepo implements MessageRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(m: Omit<CanonMessage, 'createdAt'> & { createdAt?: number }): CanonMessage {
    const full: CanonMessage = { ...m, createdAt: m.createdAt ?? Date.now() };
    this.db
      .prepare(
        `INSERT INTO message (${COLUMNS}, search_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        deriveSearchText(full.parts)
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
        `WITH RECURSIVE ancestry(id, chat_id, parent_id, role, parts, status, error, produced_by, created_at, depth) AS (
           SELECT id, chat_id, parent_id, role, parts, status, error, produced_by, created_at, 0
             FROM message WHERE id = ?
           UNION ALL
           SELECT m.id, m.chat_id, m.parent_id, m.role, m.parts, m.status, m.error, m.produced_by, m.created_at, a.depth + 1
             FROM message m JOIN ancestry a ON m.id = a.parent_id
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
      .prepare(`UPDATE message SET status = ?, error = ? WHERE id = ?`)
      .run(status, toJsonNullable(error ?? null), id);
    if (Number(result.changes) === 0) {
      throw new Error(`message: not found: ${id}`);
    }
  }

  searchText(query: string, limit: number): { messageId: string; chatId: string; snippet: string }[] {
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, m.chat_id AS chat_id,
                snippet(message_fts, 0, '[', ']', '...', 12) AS snippet
           FROM message_fts f
           JOIN message m ON m.rowid = f.rowid
          WHERE message_fts MATCH ?
          ORDER BY rank
          LIMIT ?`
      )
      .all(query, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      messageId: r.id as string,
      chatId: r.chat_id as string,
      snippet: r.snippet as string,
    }));
  }
}
