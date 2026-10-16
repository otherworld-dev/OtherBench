import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MEMORY_VERSIONS_KEPT } from '@otherbench/core/domain/memory.js';
import type { MemoryAuthor, ProjectMemory, ProjectMemoryRepo, ProjectMemoryVersion } from '@otherbench/core/ports/store.js';
import { clockOf, type SyncClock } from './clock.js';

function toMemory(row: Record<string, unknown>): ProjectMemory {
  return {
    projectId: row.project_id as string,
    body: row.body as string,
    updatedAt: row.updated_at as number,
    updatedBy: row.updated_by as MemoryAuthor,
    sourceChatId: row.source_chat_id as string | null,
  };
}

function toVersion(row: Record<string, unknown>): ProjectMemoryVersion {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    body: row.body as string,
    createdAt: row.created_at as number,
    createdBy: row.created_by as MemoryAuthor,
    sourceChatId: row.source_chat_id as string | null,
  };
}

/** Project memory notes and their versions (migration 008). */
export class SqliteProjectMemoryRepo implements ProjectMemoryRepo {
  /** The note is synced (`clock` stamps it, migration 013); its version history stays on this machine. */
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: SyncClock = clockOf(db)
  ) {}

  get(projectId: string): ProjectMemory | null {
    const row = this.db.prepare('SELECT * FROM project_memory WHERE project_id = ?').get(projectId) as Record<string, unknown> | undefined;
    return row ? toMemory(row) : null;
  }

  /** One transaction: upsert the note, add the version, prune beyond the newest MEMORY_VERSIONS_KEPT. */
  save(projectId: string, body: string, by: MemoryAuthor, sourceChatId: string | null, at: number = Date.now()): ProjectMemory {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO project_memory (project_id, body, updated_at, updated_by, source_chat_id, hlc) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at,
             updated_by = excluded.updated_by, source_chat_id = excluded.source_chat_id, hlc = excluded.hlc`
        )
        .run(projectId, body, at, by, sourceChatId, this.clock.stamp());
      this.db
        .prepare('INSERT INTO project_memory_version (id, project_id, body, created_at, created_by, source_chat_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), projectId, body, at, by, sourceChatId);
      this.db
        .prepare(
          `DELETE FROM project_memory_version WHERE project_id = ? AND id NOT IN (
             SELECT id FROM project_memory_version WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`
        )
        .run(projectId, projectId, MEMORY_VERSIONS_KEPT);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { projectId, body, updatedAt: at, updatedBy: by, sourceChatId };
  }

  versions(projectId: string): ProjectMemoryVersion[] {
    const rows = this.db
      .prepare('SELECT * FROM project_memory_version WHERE project_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(projectId) as Record<string, unknown>[];
    return rows.map(toVersion);
  }

  version(id: string): ProjectMemoryVersion | null {
    const row = this.db.prepare('SELECT * FROM project_memory_version WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toVersion(row) : null;
  }
}
