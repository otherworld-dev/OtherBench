import type { DatabaseSync } from 'node:sqlite';
import type { NodeRepo } from '@otherbench/core/ports/store.js';
import type { NodeInfo } from '@otherbench/core/types/workspace.js';

/** This machine's identity (`node_self`, created once by migration 011). */
export class SqliteNodeRepo implements NodeRepo {
  private cachedId: string | null = null;

  constructor(private readonly db: DatabaseSync) {}

  /** The id never changes once created, so it's read once; the name is read every time. */
  selfId(): string {
    if (this.cachedId === null) this.cachedId = this.self().id;
    return this.cachedId;
  }

  self(): NodeInfo {
    const row = this.db.prepare('SELECT id, name FROM node_self ORDER BY created_at ASC, id ASC LIMIT 1').get() as
      | { id: string; name: string }
      | undefined;
    if (!row) throw new Error('node_self: this database has no machine identity (migration 011 not applied)');
    return { id: row.id, name: row.name };
  }

  rename(name: string): NodeInfo {
    this.db.prepare('UPDATE node_self SET name = ? WHERE id = ?').run(name, this.selfId());
    return this.self();
  }
}

/** This machine's id, read from the database on first use: the default for a repo built on its own. */
export function selfIdOf(db: DatabaseSync): () => string {
  const nodes = new SqliteNodeRepo(db);
  return () => nodes.selfId();
}
