import type { DatabaseSync } from 'node:sqlite';
import type { NewProject, Project, ProjectRepo } from '@grunt/core/ports/store.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';

const mapping: CrudMapping<Project> = {
  table: 'project',
  columns: ['id', 'name', 'workspace_root', 'default_profile_id', 'sort_order', 'created_at', 'updated_at'],
  toRow: (p) => [p.id, p.name, p.workspaceRoot, p.defaultProfileId, p.sortOrder, p.createdAt, p.updatedAt],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    workspaceRoot: row.workspace_root as string | null,
    defaultProfileId: row.default_profile_id as string | null,
    sortOrder: row.sort_order as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  }),
};

export class SqliteProjectRepo implements ProjectRepo {
  private readonly crud: SqliteCrudRepo<Project>;

  constructor(private readonly db: DatabaseSync) {
    this.crud = new SqliteCrudRepo(db, mapping);
  }

  create(p: NewProject): Project {
    const now = Date.now();
    return this.crud.create({ ...p, sortOrder: p.sortOrder ?? 0, createdAt: p.createdAt ?? now, updatedAt: p.updatedAt ?? now });
  }

  get(id: string): Project | null {
    return this.crud.get(id);
  }

  /** Same order as `compareProjects` (@grunt/core/domain/projects.js). */
  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM project ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => mapping.fromRow(r));
  }

  update(id: string, patch: Partial<Omit<Project, 'id'>>): Project {
    return this.crud.update(id, patch);
  }

  /** Its chats keep existing: chat.project_id is ON DELETE SET NULL (migration 007). */
  delete(id: string): void {
    this.crud.delete(id);
  }
}
