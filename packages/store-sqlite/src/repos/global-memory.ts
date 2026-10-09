import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MEMORY_VERSIONS_KEPT } from '@grunt/core/domain/memory.js';
import type { GlobalMemory, GlobalMemoryRepo, GlobalMemoryVersion, MemoryAuthor } from '@grunt/core/ports/store.js';
import { clockOf, type SyncClock } from './clock.js';

type Key = 'about' | 'note';

function toVersion(row: Record<string, unknown>): GlobalMemoryVersion {
  return {
    id: row.id as string,
    body: row.body as string,
    createdAt: row.created_at as number,
    createdBy: row.created_by as MemoryAuthor,
    sourceChatId: row.source_chat_id as string | null,
  };
}

/** About you and the learned note (migration 019): two synced rows, so neither overwrites the other; the note's versions stay here. */
export class SqliteGlobalMemoryRepo implements GlobalMemoryRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: SyncClock = clockOf(db)
  ) {}

  get(): GlobalMemory {
    const rows = this.db.prepare('SELECT * FROM global_memory').all() as Record<string, unknown>[];
    const about = rows.find((r) => r.key === 'about');
    const note = rows.find((r) => r.key === 'note');
    return {
      about: (about?.body as string | undefined) ?? '',
      aboutUpdatedAt: (about?.updated_at as number | undefined) ?? 0,
      note: (note?.body as string | undefined) ?? '',
      noteUpdatedAt: (note?.updated_at as number | undefined) ?? 0,
      noteUpdatedBy: (note?.updated_by as MemoryAuthor | undefined) ?? 'user',
      noteSourceChatId: (note?.source_chat_id as string | null | undefined) ?? null,
    };
  }

  saveAbout(about: string, at: number = Date.now()): GlobalMemory {
    this.upsert('about', about, at, 'user', null);
    return this.get();
  }

  /** One transaction: upsert the note, add the version, prune beyond the newest MEMORY_VERSIONS_KEPT. */
  saveNote(body: string, by: MemoryAuthor, sourceChatId: string | null, at: number = Date.now()): GlobalMemory {
    this.db.exec('BEGIN');
    try {
      this.upsert('note', body, at, by, sourceChatId);
      this.db
        .prepare('INSERT INTO global_memory_version (id, body, created_at, created_by, source_chat_id) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), body, at, by, sourceChatId);
      this.db
        .prepare('DELETE FROM global_memory_version WHERE id NOT IN (SELECT id FROM global_memory_version ORDER BY created_at DESC, rowid DESC LIMIT ?)')
        .run(MEMORY_VERSIONS_KEPT);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.get();
  }

  versions(): GlobalMemoryVersion[] {
    const rows = this.db.prepare('SELECT * FROM global_memory_version ORDER BY created_at DESC, rowid DESC').all() as Record<string, unknown>[];
    return rows.map(toVersion);
  }

  version(id: string): GlobalMemoryVersion | null {
    const row = this.db.prepare('SELECT * FROM global_memory_version WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toVersion(row) : null;
  }

  private upsert(key: Key, body: string, at: number, by: MemoryAuthor, sourceChatId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO global_memory (key, body, updated_at, updated_by, source_chat_id, hlc) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by, source_chat_id = excluded.source_chat_id, hlc = excluded.hlc`
      )
      .run(key, body, at, by, sourceChatId, this.clock.stamp());
  }
}
