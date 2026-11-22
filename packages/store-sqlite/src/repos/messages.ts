import type { DatabaseSync } from 'node:sqlite';
import { agentStatusOf, STATUS_TOOL } from '@otherbench/core/domain/chat-status-tool.js';
import { asksUser, QUESTION_TAIL } from '@otherbench/core/domain/overview.js';
import type { MessageOutline, MessageRepo } from '@otherbench/core/ports/store.js';
import type { ChatHead } from '@otherbench/core/types/overview.js';
import type {
  CanonMessage,
  EngineMeta,
  MessageStatus,
  Part,
  ProducedBy,
  Role,
  SerializedError,
  SubagentStatus,
} from '@otherbench/core/types/messages.js';
import { atomic, fromJson, fromJsonNullable, toJson, toJsonNullable } from './util.js';
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
//   - updateParts()/reviseParts()/updateStatus(): throw when the id does not exist
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

  // updateParts leaves `hlc` alone, so a streaming checkpoint never counts as a change; this
  // stamps it, so the change-log trigger logs it and paired machines are sent the new parts.
  reviseParts(id: string, parts: Part[]): void {
    const result = this.db
      .prepare(`UPDATE message SET parts = ?, search_text = ?, hlc = ? WHERE id = ?`)
      .run(toJson(parts), deriveSearchText(parts), this.clock.stamp(), id);
    if (Number(result.changes) === 0) {
      throw new Error(`message: not found: ${id}`);
    }
  }

  // `error` omitted means "clear it" rather than "leave it": a message moving
  // to `complete` after a failed attempt must not keep the stale error.
  //
  // The status and the change log move together (`atomic`): a failure part way
  // leaves the reply as it was and the log entries of what hangs off it where
  // they were, so a reply is never stopped with those dropped from what a peer
  // is sent (`relogDependents`).
  //
  // `finished_at` is when it stopped: now as it leaves streaming, cleared as it
  // streams again (a retry). It's in the same stamped write, so it syncs with the row.
  updateStatus(id: string, status: MessageStatus, error?: SerializedError | null): void {
    atomic(this.db, () => {
      const result = this.db
        .prepare(`UPDATE message SET status = ?, error = ?, finished_at = ?, hlc = ? WHERE id = ?`)
        .run(status, toJsonNullable(error ?? null), status === 'streaming' ? null : Date.now(), this.clock.stamp(), id);
      if (Number(result.changes) === 0) {
        throw new Error(`message: not found: ${id}`);
      }
      if (status !== 'streaming') this.relogDependents(id);
    });
  }

  /**
   * Logs again, behind message `id` (which has just stopped streaming), every row that hangs off it.
   *
   * The files of a reply (a tool's screenshots), its usage (a sub-agent's is written while the reply
   * still runs) and any message placed under it are rows made while it was streaming, so they were
   * logged before the message could be sent, and a peer that pulled in between had to turn them down:
   * their parent wasn't there. That peer's cursor has moved past them, so nothing would offer them
   * again. Now that the message follows, they do too: logged again, after it (the old entries go
   * first, so their place in the log is behind the message's, even when a batch ends between the two).
   *
   * A message under it brings its own files, usage and replies the same way, parents before children.
   * One still streaming is left, with everything under it, for when it stops itself. A peer that
   * already has a row logged again is sent it once more and changes nothing (its stamp is the same).
   */
  private relogDependents(id: string): void {
    const unlog = this.db.prepare(`DELETE FROM change_log WHERE tbl = 'message' AND row_id = ?`);
    const log = this.db.prepare(`INSERT INTO change_log (tbl, row_id, op) VALUES ('message', ?, 'upsert')`);
    const unlogOf = (tbl: 'attachment' | 'usage') => this.db.prepare(`DELETE FROM change_log WHERE tbl = '${tbl}' AND row_id IN (SELECT id FROM ${tbl} WHERE message_id = ?)`);
    const logOf = (tbl: 'attachment' | 'usage') => this.db.prepare(`INSERT INTO change_log (tbl, row_id, op) SELECT '${tbl}', id, 'upsert' FROM ${tbl} WHERE message_id = ?`);
    const hanging = [unlogOf('attachment'), logOf('attachment'), unlogOf('usage'), logOf('usage')];
    const children = this.db.prepare(`SELECT id FROM message WHERE parent_id = ? AND status != 'streaming' ORDER BY created_at ASC, id ASC`);

    // Breadth first, so a message is always logged before what is under it. `seen` ends a parent cycle (see MAX_PATH_DEPTH).
    const seen = new Set([id]);
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      const messageId = queue[i]!;
      // The message that stopped was logged by its own update (the trigger); the ones under it are logged here.
      if (messageId !== id) {
        unlog.run(messageId);
        log.run(messageId);
      }
      for (const statement of hanging) statement.run(messageId);
      for (const child of children.all(messageId) as { id: string }[]) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        queue.push(child.id);
      }
    }
  }

  heads(chatId?: string): ChatHead[] {
    // A send leaves the head on the user's message and the reply is its child, so the
    // tip is the newest message at or below the head. UNION (not UNION ALL) stops a
    // parent cycle from recursing forever.
    const rows = this.db
      .prepare(
        `WITH RECURSIVE below(chat_id, id) AS (
           SELECT c.id, c.head_message_id FROM chat c
            WHERE c.archived_at IS NULL AND c.head_message_id IS NOT NULL AND (?1 IS NULL OR c.id = ?1)
           UNION
           SELECT b.chat_id, m.id FROM message m JOIN below b ON m.parent_id = b.id
         ),
         ranked AS (
           SELECT b.chat_id, m.id,
                  ROW_NUMBER() OVER (PARTITION BY b.chat_id ORDER BY m.created_at DESC, m.id DESC) AS rn
             FROM below b JOIN message m ON m.id = b.id
         )
         -- Only each chat's tip is read past its id: the text's tail, and of a finished reply's parts only its own
         -- set_chat_status calls and results (top level, so a helper's never come), so the list parses next to nothing.
         SELECT r.chat_id, m.role, m.status, m.created_at, m.finished_at, substr(m.search_text, -?2) AS tail,
                CASE WHEN m.role = 'assistant' AND m.status = 'complete' AND instr(m.parts, ?3) > 0
                  THEN (SELECT json_group_array(json(j.value)) FROM json_each(m.parts) j WHERE json_extract(j.value, '$.name') = ?3)
                END AS status_parts
           FROM ranked r JOIN message m ON m.id = r.id WHERE r.rn = 1`
      )
      .all(chatId ?? null, QUESTION_TAIL, STATUS_TOOL) as Record<string, unknown>[];
    return rows.map((r) => {
      const head: ChatHead = { chatId: r.chat_id as string, role: r.role as Role, status: r.status as MessageStatus, createdAt: r.created_at as number };
      if (r.finished_at != null) head.finishedAt = r.finished_at as number;
      if (head.role !== 'assistant' || head.status !== 'complete') return head;
      if (asksUser(r.tail as string)) head.asks = true;
      const agentStatus = typeof r.status_parts === 'string' ? agentStatusOf(fromJson<Part[]>(r.status_parts)) : null;
      if (agentStatus) head.agentStatus = agentStatus;
      return head;
    });
  }

  listByStatus(status: MessageStatus): CanonMessage[] {
    // 'streaming' is written into the SQL, not bound: only then can SQLite use the partial index over
    // streaming rows (migration 055) instead of reading every message, as startup reconciliation used to.
    const rows = (
      status === 'streaming'
        ? this.db.prepare(`SELECT ${COLUMNS} FROM message WHERE status = 'streaming' ORDER BY created_at ASC, id ASC`).all()
        : this.db.prepare(`SELECT ${COLUMNS} FROM message WHERE status = ? ORDER BY created_at ASC, id ASC`).all(status)
    ) as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  // Served by the same partial index, which leads with `chat_id`: the few rows streaming in one chat.
  listStreaming(chatId: string): CanonMessage[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM message WHERE chat_id = ? AND status = 'streaming' ORDER BY created_at ASC, id ASC`)
      .all(chatId) as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  // `instr` skips the JSON parse for the many messages with no sub-agent card at all; `json_each`
  // then checks the top-level cards themselves, so a card's status mentioned in text never matches.
  listWithSubagentStatus(status: SubagentStatus): CanonMessage[] {
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM message
          WHERE instr(parts, '"type":"subagent"') > 0
            AND EXISTS (SELECT 1 FROM json_each(message.parts) p
                         WHERE json_extract(p.value, '$.type') = 'subagent' AND json_extract(p.value, '$.status') = ?)
          ORDER BY created_at ASC, id ASC`
      )
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

  outline(chatId: string): MessageOutline[] {
    const rows = this.db.prepare('SELECT id, parent_id, role FROM message WHERE chat_id = ? ORDER BY created_at ASC, id ASC').all(chatId) as { id: string; parent_id: string | null; role: Role }[];
    return rows.map((r) => ({ id: r.id, parentId: r.parent_id, role: r.role }));
  }

  chatTree(chatId: string): CanonMessage[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM message WHERE chat_id = ? ORDER BY created_at ASC, id ASC`).all(chatId) as Record<string, unknown>[];
    return rows.map(fromRow);
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
        .all(match, limit, offset);
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

  searchChats(query: string, limit: number): string[] {
    const match = toFtsMatchExpression(query);
    if (match === null) return [];

    let rows: Record<string, unknown>[];
    try {
      rows = this.db
        .prepare(
          `SELECT m.chat_id AS chat_id, MIN(f.rank) AS best
             FROM message_fts f
             JOIN message m ON m.rowid = f.rowid
            WHERE message_fts MATCH ?
            GROUP BY m.chat_id
            ORDER BY best, m.chat_id
            LIMIT ?`
        )
        .all(match, limit);
    } catch (err) {
      // Same guard as searchText.
      if (isSqliteError(err)) return [];
      throw err;
    }
    return rows.map((r) => r.chat_id as string);
  }
}
