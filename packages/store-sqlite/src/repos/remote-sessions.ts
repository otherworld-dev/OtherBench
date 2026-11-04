import type { DatabaseSync } from 'node:sqlite';
import type { RemoteSession, RemoteSessionRepo } from '@otherbench/core/ports/store.js';

function toSession(row: Record<string, unknown>): RemoteSession {
  return {
    id: row.id as string,
    tokenHash: row.token_hash as string,
    createdAt: row.created_at as number,
    lastSeenAt: row.last_seen_at as number,
    expiresAt: row.expires_at as number,
    remember: row.remember === 1,
    epoch: row.epoch as string,
    address: (row.address as string | null) ?? null,
    deviceLabel: row.device_label as string,
  };
}

/** Remote access's signed-in browsers (migration 038). Local: the table has no sync triggers. */
export class SqliteRemoteSessionRepo implements RemoteSessionRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(s: RemoteSession): void {
    this.db
      .prepare(
        `INSERT INTO remote_session (id, token_hash, created_at, last_seen_at, expires_at, remember, epoch, address, device_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(s.id, s.tokenHash, s.createdAt, s.lastSeenAt, s.expiresAt, s.remember ? 1 : 0, s.epoch, s.address, s.deviceLabel);
  }

  byTokenHash(tokenHash: string): RemoteSession | null {
    const row = this.db.prepare('SELECT * FROM remote_session WHERE token_hash = ?').get(tokenHash) as Record<string, unknown> | undefined;
    return row ? toSession(row) : null;
  }

  get(id: string): RemoteSession | null {
    const row = this.db.prepare('SELECT * FROM remote_session WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toSession(row) : null;
  }

  list(): RemoteSession[] {
    const rows = this.db.prepare('SELECT * FROM remote_session ORDER BY created_at ASC, rowid ASC').all() as Record<string, unknown>[];
    return rows.map(toSession);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM remote_session').get() as { n: number }).n;
  }

  touch(id: string, lastSeenAt: number): void {
    this.db.prepare('UPDATE remote_session SET last_seen_at = ? WHERE id = ?').run(lastSeenAt, id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM remote_session WHERE id = ?').run(id).changes) > 0;
  }
}
