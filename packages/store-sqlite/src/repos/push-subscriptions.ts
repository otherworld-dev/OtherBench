import type { DatabaseSync } from 'node:sqlite';
import type { PushSubscriptionRecord, PushSubscriptionRepo } from '@otherbench/core/ports/store.js';

function toRecord(row: Record<string, unknown>): PushSubscriptionRecord {
  return {
    sessionId: row.session_id as string,
    endpoint: row.endpoint as string,
    p256dh: row.p256dh as string,
    auth: row.auth as string,
    prefs: { approvals: row.approvals === 1, replies: row.replies === 1, scheduled: row.scheduled === 1 },
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/** Signed-in devices' Web Push subscriptions (migration 039). Local: the table has no sync triggers. */
export class SqlitePushSubscriptionRepo implements PushSubscriptionRepo {
  constructor(private readonly db: DatabaseSync) {}

  put(s: PushSubscriptionRecord): void {
    // An endpoint is one browser: if it signed in again under a new session, the old row goes.
    this.db.prepare('DELETE FROM push_subscription WHERE endpoint = ? AND session_id <> ?').run(s.endpoint, s.sessionId);
    this.db
      .prepare(
        `INSERT INTO push_subscription (session_id, endpoint, p256dh, auth, approvals, replies, scheduled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth,
           approvals = excluded.approvals, replies = excluded.replies, scheduled = excluded.scheduled, updated_at = excluded.updated_at`
      )
      .run(s.sessionId, s.endpoint, s.p256dh, s.auth, s.prefs.approvals ? 1 : 0, s.prefs.replies ? 1 : 0, s.prefs.scheduled ? 1 : 0, s.createdAt, s.updatedAt);
  }

  bySession(sessionId: string): PushSubscriptionRecord | null {
    const row = this.db.prepare('SELECT * FROM push_subscription WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : null;
  }

  list(): PushSubscriptionRecord[] {
    const rows = this.db.prepare('SELECT * FROM push_subscription ORDER BY created_at ASC, rowid ASC').all() as Record<string, unknown>[];
    return rows.map(toRecord);
  }

  deleteBySession(sessionId: string): boolean {
    return Number(this.db.prepare('DELETE FROM push_subscription WHERE session_id = ?').run(sessionId).changes) > 0;
  }

  deleteByEndpoint(endpoint: string): boolean {
    return Number(this.db.prepare('DELETE FROM push_subscription WHERE endpoint = ?').run(endpoint).changes) > 0;
  }
}
