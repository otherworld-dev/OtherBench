import type { DatabaseSync } from 'node:sqlite';
import type { LocationRepo } from '@grunt/core/ports/store.js';
import type { Location, LocationPath } from '@grunt/core/types/workspace.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { clockOf, type SyncClock } from './clock.js';

const mapping: CrudMapping<Location> = {
  table: 'location',
  columns: ['id', 'name'],
  toRow: (l) => [l.id, l.name],
  fromRow: (row) => ({ id: row.id as string, name: row.name as string }),
};

function pathFromRow(row: Record<string, unknown>): LocationPath {
  return { locationId: row.location_id as string, nodeId: row.node_id as string, path: row.path as string };
}

/** Locations and each machine's path for them (migration 011). */
export class SqliteLocationRepo implements LocationRepo {
  private readonly crud: SqliteCrudRepo<Location>;

  /** Both tables are synced: `clock` stamps their changes (migration 013). */
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: SyncClock = clockOf(db)
  ) {
    this.crud = new SqliteCrudRepo(db, mapping, clock);
  }

  list(): Location[] {
    const rows = this.db.prepare('SELECT * FROM location ORDER BY name COLLATE NOCASE ASC, id ASC').all() as Record<string, unknown>[];
    return rows.map((r) => mapping.fromRow(r));
  }

  get(id: string): Location | null {
    return this.crud.get(id);
  }

  create(l: Location): Location {
    return this.crud.create({ id: l.id, name: l.name });
  }

  update(id: string, patch: Partial<Omit<Location, 'id'>>): Location {
    return this.crud.update(id, patch);
  }

  /**
   * Its paths cascade away and chats and projects using it lose their folder
   * (both foreign keys, migration 011); the subpaths are cleared here so no
   * orphaned half of a folder is left behind.
   */
  delete(id: string): void {
    this.db.prepare('UPDATE chat SET workspace_subpath = NULL WHERE workspace_location_id = ?').run(id);
    this.db.prepare('UPDATE project SET workspace_subpath = NULL WHERE workspace_location_id = ?').run(id);
    this.crud.delete(id);
  }

  allPaths(): LocationPath[] {
    return (this.db.prepare('SELECT * FROM location_path ORDER BY location_id, node_id').all() as Record<string, unknown>[]).map(pathFromRow);
  }

  paths(locationId: string): LocationPath[] {
    return (this.db.prepare('SELECT * FROM location_path WHERE location_id = ? ORDER BY node_id').all(locationId) as Record<string, unknown>[]).map(
      pathFromRow
    );
  }

  pathsForNode(nodeId: string): LocationPath[] {
    return (this.db.prepare('SELECT * FROM location_path WHERE node_id = ? ORDER BY location_id').all(nodeId) as Record<string, unknown>[]).map(
      pathFromRow
    );
  }

  /** An unknown location fails on the foreign key. */
  setPath(p: LocationPath): LocationPath {
    this.db
      .prepare(
        `INSERT INTO location_path (location_id, node_id, path, hlc) VALUES (?, ?, ?, ?)
         ON CONFLICT (location_id, node_id) DO UPDATE SET path = excluded.path, hlc = excluded.hlc`
      )
      .run(p.locationId, p.nodeId, p.path, this.clock.stamp());
    // Set again after being removed: the removal no longer stands.
    this.db.prepare("DELETE FROM tombstone WHERE tbl = 'location_path' AND row_id = ?").run(`${p.locationId}:${p.nodeId}`);
    return { locationId: p.locationId, nodeId: p.nodeId, path: p.path };
  }

  deletePath(locationId: string, nodeId: string): void {
    this.clock.markDelete();
    this.db.prepare('DELETE FROM location_path WHERE location_id = ? AND node_id = ?').run(locationId, nodeId);
  }
}
