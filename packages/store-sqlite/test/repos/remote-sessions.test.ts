import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSyncTable, SYNC_TABLES, type ChangeRow } from '@otherbench/core/domain/sync.js';
import type { RemoteSession } from '@otherbench/core/ports/store.js';
import { openDatabase } from '../../src/db.js';
import { runMigrations } from '../../src/migrations/index.js';
import { SqliteStore } from '../../src/store.js';
import { freshDb } from '../helpers.js';

const session = (over: Partial<RemoteSession> = {}): RemoteSession => ({
  id: 's1',
  tokenHash: 'a'.repeat(64),
  createdAt: 1_000,
  lastSeenAt: 1_000,
  expiresAt: 50_000,
  remember: true,
  epoch: 'e1',
  address: '192.0.2.7',
  deviceLabel: 'Chrome on Android',
  ...over,
});

describe('SqliteRemoteSessionRepo', () => {
  it('stores, finds by token hash or id, lists oldest first, touches and deletes', () => {
    const repo = new SqliteStore(freshDb()).remoteSessions;
    repo.insert(session({ id: 's2', tokenHash: 'b'.repeat(64), createdAt: 2_000, remember: false, address: null }));
    repo.insert(session());

    expect(repo.byTokenHash('a'.repeat(64))).toEqual(session());
    expect(repo.get('s2')).toMatchObject({ remember: false, address: null });
    expect(repo.list().map((s) => s.id)).toEqual(['s1', 's2']);
    expect(repo.count()).toBe(2);

    repo.touch('s1', 9_000);
    expect(repo.get('s1')?.lastSeenAt).toBe(9_000);

    expect(repo.delete('s1')).toBe(true);
    expect(repo.delete('s1')).toBe(false);
    expect(repo.byTokenHash('a'.repeat(64))).toBeNull();
    expect(repo.count()).toBe(1);
  });

  it('keeps sessions in the database file, so a reopened store still has them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'otherbench-sessions-'));
    const path = join(dir, 'otherbench.db');
    try {
      const first = openDatabase(path);
      runMigrations(first);
      new SqliteStore(first).remoteSessions.insert(session());
      first.close();

      const second = openDatabase(path);
      runMigrations(second);
      expect(new SqliteStore(second).remoteSessions.byTokenHash('a'.repeat(64))).toEqual(session());
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never syncs: no sync triggers, nothing in the change log, not a sync table, refused in a batch', () => {
    const db = freshDb();
    const store = new SqliteStore(db);
    const before = store.sync.latestSeq();

    store.remoteSessions.insert(session());
    store.remoteSessions.touch('s1', 5_000);
    store.remoteSessions.delete('s1');

    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'remote_session'").all();
    expect(triggers).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE tbl = 'remote_session'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tombstone WHERE tbl = 'remote_session'").get()).toEqual({ n: 0 });
    expect(store.sync.latestSeq()).toBe(before);
    expect(store.sync.changesSince(0, 10_000).rows.some((r) => (r.tbl as string) === 'remote_session')).toBe(false);
    expect(SYNC_TABLES as readonly string[]).not.toContain('remote_session');
    expect(isSyncTable('remote_session')).toBe(false);

    // A paired machine can't plant one either: a batch naming the table is skipped.
    const planted = {
      tbl: 'remote_session',
      id: 's9',
      op: 'upsert',
      hlc: '9999999999999-0000-peer',
      row: { id: 's9', token_hash: 'c'.repeat(64), created_at: 1, last_seen_at: 1, expires_at: 9e15, remember: 1, epoch: 'e1', address: null, device_label: 'x' },
    } as unknown as ChangeRow;
    store.sync.apply([planted]);
    expect(store.remoteSessions.count()).toBe(0);
  });
});
