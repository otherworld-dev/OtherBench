import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { APP_NOTES_VERSIONS_KEPT } from '@otherbench/core/domain/app-notes.js';
import type { AppNotes, AppNotesRepo, AppNotesVersion } from '@otherbench/core/ports/store.js';
import { clockOf, type SyncClock } from './clock.js';

function toNotes(row: Record<string, unknown>): AppNotes {
  return {
    appId: row.app_id as string,
    body: row.body as string,
    updatedAt: row.updated_at as number,
    sourceChatId: row.source_chat_id as string | null,
    mirroredAt: row.mirrored_at as number | null,
  };
}

function toVersion(row: Record<string, unknown>): AppNotesVersion {
  return {
    id: row.id as string,
    appId: row.app_id as string,
    body: row.body as string,
    createdAt: row.created_at as number,
    sourceChatId: row.source_chat_id as string | null,
  };
}

/** App notes and their versions (migration 041). */
export class SqliteAppNotesRepo implements AppNotesRepo {
  /** The notes are synced (`clock` stamps them); `mirrored_at` and the version history stay on this machine. */
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: SyncClock = clockOf(db)
  ) {}

  get(appId: string): AppNotes | null {
    const row = this.db.prepare('SELECT * FROM app_notes WHERE app_id = ?').get(appId) as Record<string, unknown> | undefined;
    return row ? toNotes(row) : null;
  }

  list(): AppNotes[] {
    return (this.db.prepare('SELECT * FROM app_notes ORDER BY app_id').all() as Record<string, unknown>[]).map(toNotes);
  }

  /** One transaction: upsert the notes (keeping `mirrored_at`), add the version, prune beyond the newest APP_NOTES_VERSIONS_KEPT. */
  save(appId: string, body: string, sourceChatId: string | null, at: number = Date.now()): AppNotes {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO app_notes (app_id, body, updated_at, source_chat_id, hlc) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(app_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at,
             source_chat_id = excluded.source_chat_id, hlc = excluded.hlc`
        )
        .run(appId, body, at, sourceChatId, this.clock.stamp());
      this.db.prepare('INSERT INTO app_notes_version (id, app_id, body, created_at, source_chat_id) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), appId, body, at, sourceChatId);
      this.db
        .prepare(
          `DELETE FROM app_notes_version WHERE app_id = ? AND id NOT IN (
             SELECT id FROM app_notes_version WHERE app_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`
        )
        .run(appId, appId, APP_NOTES_VERSIONS_KEPT);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.get(appId)!;
  }

  /** Leaves `hlc` alone, so the sync triggers don't log it: the mirror is this machine's own business. */
  markMirrored(appId: string, at: number): void {
    this.db.prepare('UPDATE app_notes SET mirrored_at = ? WHERE app_id = ?').run(at, appId);
  }

  versions(appId: string): AppNotesVersion[] {
    const rows = this.db.prepare('SELECT * FROM app_notes_version WHERE app_id = ? ORDER BY created_at DESC, rowid DESC').all(appId) as Record<string, unknown>[];
    return rows.map(toVersion);
  }

  version(id: string): AppNotesVersion | null {
    const row = this.db.prepare('SELECT * FROM app_notes_version WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toVersion(row) : null;
  }
}
