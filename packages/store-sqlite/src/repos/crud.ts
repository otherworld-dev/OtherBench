import type { DatabaseSync } from 'node:sqlite';
import type { SyncClock } from './clock.js';

/** The subset of `node:sqlite`'s `SQLInputValue` this schema actually uses (no blobs, no bigint). */
export type SqlBindValue = string | number | null;

/**
 * Maps an entity <-> the flat row shape of a single SQLite table.
 *
 * Invariant `SqliteCrudRepo` relies on: `columns[0]` MUST be `'id'`, and
 * `toRow(entity)` MUST return bind values in exactly that column order.
 * `update()` uses this to build `SET col = ?, ...` from the same array it
 * uses for `INSERT`, just sliced past the id.
 */
export interface CrudMapping<T extends { id: string }> {
  table: string;
  columns: string[];
  toRow(entity: T): SqlBindValue[];
  fromRow(row: Record<string, unknown>): T;
}

/**
 * Hand-written (not an ORM) SQL helper shared by the simple, non-tree repos
 * (connections/models/profiles/chats/attachments/usage/mcpServers/grants/
 * audit -- messages is a tree and owns its own repo/queries entirely). Each
 * caller still supplies its own real SQL column list and row<->entity
 * mapping via `CrudMapping`; this only factors out the mechanical
 * INSERT/SELECT/UPDATE/DELETE statement shapes, the same way
 * `InMemoryCrudRepo` factors the equivalent shape for the in-memory fakes
 * (packages/core/src/testing/fakes.ts) -- kept structurally comparable to
 * that on purpose, since store-contract.ts holds both to the same policy:
 *
 *   - create(): a duplicate id throws. The table's PRIMARY KEY constraint
 *     does this for free; no extra code needed here.
 *   - get(): returns null for an unknown id (a SELECT matching zero rows).
 *   - list() / listWhere(): return [] when nothing matches.
 *   - update(): throws if the id doesn't exist (checked by re-`get`-ing
 *     first, so the "not found" error is raised before ever running the
 *     UPDATE -- the affected-row-count check afterwards is a second,
 *     belt-and-suspenders guard against the row disappearing between the
 *     two statements).
 *   - delete(): a no-op if the id doesn't exist (idempotent by construction
 *     -- a `DELETE ... WHERE id = ?` that matches zero rows isn't an error).
 */
export class SqliteCrudRepo<T extends { id: string }> {
  /**
   * With `clock`, the table is synced (migration 013): every insert and
   * update writes a fresh `hlc` stamp, and a delete first sets the stamp its
   * tombstones get.
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly mapping: CrudMapping<T>,
    private readonly clock?: SyncClock
  ) {}

  /** `stamp` (synced tables only): the stamp to write, or omitted for a fresh one. */
  create(entity: T, stamp?: string): T {
    const columns = this.clock ? [...this.mapping.columns, 'hlc'] : this.mapping.columns;
    const values = this.clock ? [...this.mapping.toRow(entity), stamp ?? this.clock.stamp()] : this.mapping.toRow(entity);
    this.db
      .prepare(`INSERT INTO ${this.mapping.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...values);
    return entity;
  }

  get(id: string): T | null {
    const row = this.db.prepare(`SELECT * FROM ${this.mapping.table} WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapping.fromRow(row) : null;
  }

  list(): T[] {
    const rows = this.db.prepare(`SELECT * FROM ${this.mapping.table}`).all() as Record<string, unknown>[];
    return rows.map((r) => this.mapping.fromRow(r));
  }

  /** `list()` filtered by an arbitrary WHERE clause, for repos that filter by a foreign key. */
  listWhere(where: string, ...params: SqlBindValue[]): T[] {
    const rows = this.db.prepare(`SELECT * FROM ${this.mapping.table} WHERE ${where}`).all(...params) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.mapping.fromRow(r));
  }

  /**
   * `stamp` (synced tables only): the stamp to write, `false` to leave the
   * row's stamp alone (a change that isn't one to sync, like a health
   * check), or omitted for a fresh one.
   */
  update(id: string, patch: Partial<Omit<T, 'id'>>, stamp?: string | false): T {
    const current = this.get(id);
    if (!current) {
      throw new Error(`${this.mapping.table}: not found: ${id}`);
    }
    const updated = { ...current, ...patch, id } as T;
    const values = this.mapping.toRow(updated).slice(1);
    const nonIdColumns = this.mapping.columns.slice(1);
    if (this.clock && stamp !== false) {
      nonIdColumns.push('hlc');
      values.push(stamp ?? this.clock.stamp());
    }
    const setClause = nonIdColumns.map((c) => `${c} = ?`).join(', ');
    const result = this.db
      .prepare(`UPDATE ${this.mapping.table} SET ${setClause} WHERE id = ?`)
      .run(...values, id);
    if (Number(result.changes) === 0) {
      throw new Error(`${this.mapping.table}: not found: ${id}`);
    }
    return updated;
  }

  delete(id: string): void {
    this.clock?.markDelete();
    this.db.prepare(`DELETE FROM ${this.mapping.table} WHERE id = ?`).run(id);
  }
}
