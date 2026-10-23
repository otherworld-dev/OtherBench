import type { DatabaseSync } from 'node:sqlite';
import type { MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';
import type { MediaWorkflowRepo } from '@otherbench/core/ports/store.js';
import { SqliteCrudRepo, type CrudMapping } from './crud.js';
import { clockOf, type SyncClock } from './clock.js';
import { selfIdOf } from './nodes.js';

const mapping: CrudMapping<MediaWorkflow> = {
  table: 'media_workflow',
  columns: ['id', 'name', 'media', 'graph', 'bindings', 'checkpoint', 'updated_at'],
  toRow: (w) => [w.id, w.name, w.media, JSON.stringify(w.graph), JSON.stringify(w.bindings), w.checkpoint ?? null, Date.now()],
  fromRow: (row) => ({
    id: row.id as string,
    name: row.name as string,
    media: row.media as MediaWorkflow['media'],
    graph: JSON.parse(row.graph as string) as MediaWorkflow['graph'],
    bindings: JSON.parse(row.bindings as string) as MediaWorkflow['bindings'],
    ...(row.checkpoint == null ? {} : { checkpoint: row.checkpoint as string }),
    builtin: false,
  }),
};

/** Imported ComfyUI workflows (migration 031); a synced table. */
export class SqliteMediaWorkflowRepo implements MediaWorkflowRepo {
  private readonly crud: SqliteCrudRepo<MediaWorkflow>;

  constructor(
    private readonly db: DatabaseSync,
    clock: SyncClock = clockOf(db, selfIdOf(db))
  ) {
    this.crud = new SqliteCrudRepo(db, mapping, clock);
  }

  list(): MediaWorkflow[] {
    const rows = this.db.prepare('SELECT * FROM media_workflow ORDER BY created_at ASC, name COLLATE NOCASE ASC, id ASC').all() as Record<string, unknown>[];
    return rows.map((r) => mapping.fromRow(r));
  }

  get(id: string): MediaWorkflow | null {
    return this.crud.get(id);
  }

  create(wf: MediaWorkflow): MediaWorkflow {
    return this.crud.create({ ...wf, builtin: false });
  }

  update(id: string, patch: Partial<Omit<MediaWorkflow, 'id' | 'builtin'>>): MediaWorkflow {
    return this.crud.update(id, patch);
  }

  delete(id: string): void {
    this.crud.delete(id);
  }
}
