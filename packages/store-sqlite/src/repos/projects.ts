import type { DatabaseSync } from 'node:sqlite';
import type { NewProject, Project, ProjectRepo } from '@grunt/core/ports/store.js';
import { toStoredWorkspace } from '@grunt/core/domain/workspace.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { WORKSPACE_COLUMNS, workspaceFromRow, workspaceToRow } from './workspace-columns.js';
import { selfIdOf } from './nodes.js';
import { clockOf, type SyncClock } from './clock.js';

function projectMapping(selfId: () => string): CrudMapping<Project> {
  return {
    table: 'project',
    columns: ['id', 'name', ...WORKSPACE_COLUMNS, 'default_profile_id', 'sort_order', 'created_at', 'updated_at'],
    toRow: (p) => [p.id, p.name, ...workspaceToRow(p.workspace), p.defaultProfileId, p.sortOrder, p.createdAt, p.updatedAt],
    fromRow: (row) => ({
      id: row.id as string,
      name: row.name as string,
      workspace: workspaceFromRow(row, selfId),
      defaultProfileId: row.default_profile_id as string | null,
      sortOrder: row.sort_order as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }),
  };
}

export class SqliteProjectRepo implements ProjectRepo {
  private readonly crud: SqliteCrudRepo<Project>;
  private readonly mapping: CrudMapping<Project>;

  constructor(
    private readonly db: DatabaseSync,
    private readonly selfId: () => string = selfIdOf(db),
    clock: SyncClock = clockOf(db, selfId)
  ) {
    this.mapping = projectMapping(selfId);
    this.crud = new SqliteCrudRepo(db, this.mapping, clock);
  }

  create(p: NewProject): Project {
    const now = Date.now();
    const fields = toStoredWorkspace(p, this.selfId());
    return this.crud.create({
      ...fields,
      workspace: fields.workspace ?? null,
      sortOrder: p.sortOrder ?? 0,
      createdAt: p.createdAt ?? now,
      updatedAt: p.updatedAt ?? now,
    });
  }

  get(id: string): Project | null {
    return this.crud.get(id);
  }

  /** Same order as `compareProjects` (@grunt/core/domain/projects.js). */
  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM project ORDER BY sort_order ASC, name COLLATE NOCASE ASC, id ASC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapping.fromRow(r));
  }

  update(id: string, patch: Partial<Omit<Project, 'id'>>): Project {
    return this.crud.update(id, toStoredWorkspace(patch, this.selfId()) as Partial<Omit<Project, 'id'>>);
  }

  /**
   * Its chats keep existing: chat.project_id is ON DELETE SET NULL (migration
   * 007), and their memory cursors are cleared here to match ChatRepo.update.
   * Its memory note and versions cascade away (migration 008).
   */
  delete(id: string): void {
    this.db.prepare('UPDATE chat SET memory_cursor = NULL WHERE project_id = ?').run(id);
    this.crud.delete(id);
  }
}
