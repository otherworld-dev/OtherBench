import type { DatabaseSync } from 'node:sqlite';
import type { AppFolder, AppFolderRepo, NewAppFolder } from '@otherbench/core/ports/store.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { SqliteAppRepo } from './apps.js';
import { selfIdOf } from './nodes.js';
import { clockOf, type SyncClock } from './clock.js';

const mapping: CrudMapping<AppFolder> = {
  table: 'app_folder',
  columns: ['id', 'name', 'sort_order', 'created_at', 'updated_at'],
  toRow: (f) => [f.id, f.name, f.sortOrder, f.createdAt, f.updatedAt],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    sortOrder: row.sort_order as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }),
};

/** Folders for the Code sidebar's apps (migration 032); a synced table. */
export class SqliteAppFolderRepo implements AppFolderRepo {
  private readonly crud: SqliteCrudRepo<AppFolder>;
  private readonly apps: SqliteAppRepo;

  constructor(
    private readonly db: DatabaseSync,
    selfId: () => string = selfIdOf(db),
    clock: SyncClock = clockOf(db, selfId)
  ) {
    this.crud = new SqliteCrudRepo(db, mapping, clock);
    this.apps = new SqliteAppRepo(db, selfId, clock);
  }

  create(f: NewAppFolder): AppFolder {
    const now = Date.now();
    return this.crud.create({ id: f.id, name: f.name, sortOrder: f.sortOrder ?? 0, createdAt: now, updatedAt: now });
  }

  get(id: string): AppFolder | null {
    return this.crud.get(id);
  }

  /** Same order as `compareAppFolders` (@otherbench/core/domain/apps.js). */
  list(): AppFolder[] {
    const rows = this.db.prepare('SELECT * FROM app_folder ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC').all() as Record<string, unknown>[];
    return rows.map((r) => mapping.fromRow(r));
  }

  update(id: string, patch: Partial<Pick<AppFolder, 'name' | 'sortOrder'>>): AppFolder {
    return this.crud.update(id, { ...patch, updatedAt: Date.now() });
  }

  /**
   * Its apps keep existing. `app.folder_id` has no foreign key (migration 032),
   * so it is cleared here through the app repo's `update`, which stamps the
   * field and logs the change: other machines would otherwise only see the
   * folder's deletion and keep apps pointing at it.
   */
  delete(id: string): void {
    const apps = this.db.prepare('SELECT id FROM app WHERE folder_id = ?').all(id) as { id: string }[];
    for (const app of apps) this.apps.update(app.id, { folderId: null });
    this.crud.delete(id);
  }
}
