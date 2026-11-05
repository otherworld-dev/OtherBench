import { describe, expect, it } from 'vitest';
import { isSyncTable, SYNC_TABLES, type ChangeRow } from '@otherbench/core/domain/sync.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { PushSubscriptionRecord, RemoteSession, Store } from '@otherbench/core/ports/store.js';
import { SqliteStore } from '../../src/store.js';
import { freshDb } from '../helpers.js';

const session = (id: string): RemoteSession => ({
  id,
  tokenHash: id.padEnd(64, '0'),
  createdAt: 1_000,
  lastSeenAt: 1_000,
  expiresAt: 50_000,
  remember: true,
  epoch: 'e1',
  address: '192.0.2.7',
  deviceLabel: 'Safari on iPhone',
});

const sub = (over: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord => ({
  sessionId: 's1',
  endpoint: 'https://web.push.apple.com/abc',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  prefs: { approvals: true, replies: false, scheduled: true },
  createdAt: 2_000,
  updatedAt: 2_000,
  ...over,
});

// The same contract for the SQLite repo and core's in-memory fake.
const stores: [string, () => Store][] = [
  ['SQLite', () => new SqliteStore(freshDb())],
  ['in memory', () => new InMemoryStore()],
];

describe.each(stores)('push subscriptions (%s)', (_name, make) => {
  it('stores one per session, updates it in place, lists and deletes', () => {
    const store = make();
    store.remoteSessions.insert(session('s1'));
    store.remoteSessions.insert(session('s2'));
    const repo = store.pushSubscriptions;

    repo.put(sub());
    repo.put(sub({ sessionId: 's2', endpoint: 'https://fcm.googleapis.com/fcm/send/xyz', createdAt: 3_000 }));
    expect(repo.bySession('s1')).toEqual(sub());
    expect(repo.list().map((s) => s.sessionId)).toEqual(['s1', 's2']);

    // The same session subscribing again (new keys, other prefs) replaces its row.
    repo.put(sub({ auth: 'AAAAAAAAAAAAAAAAAAAAAA', prefs: { approvals: false, replies: true, scheduled: false }, updatedAt: 4_000 }));
    expect(repo.bySession('s1')).toMatchObject({ auth: 'AAAAAAAAAAAAAAAAAAAAAA', prefs: { approvals: false, replies: true, scheduled: false }, createdAt: 2_000, updatedAt: 4_000 });
    expect(repo.list()).toHaveLength(2);

    expect(repo.deleteBySession('s1')).toBe(true);
    expect(repo.deleteBySession('s1')).toBe(false);
    expect(repo.deleteByEndpoint('https://fcm.googleapis.com/fcm/send/xyz')).toBe(true);
    expect(repo.deleteByEndpoint('https://fcm.googleapis.com/fcm/send/xyz')).toBe(false);
    expect(repo.list()).toEqual([]);
  });

  it('moves an endpoint to the session that subscribed it last (one browser, signed in again)', () => {
    const store = make();
    store.remoteSessions.insert(session('s1'));
    store.remoteSessions.insert(session('s2'));
    store.pushSubscriptions.put(sub());
    store.pushSubscriptions.put(sub({ sessionId: 's2' }));
    expect(store.pushSubscriptions.list().map((s) => s.sessionId)).toEqual(['s2']);
  });

  it('is deleted with its session, and refused without one', () => {
    const store = make();
    store.remoteSessions.insert(session('s1'));
    store.pushSubscriptions.put(sub());
    store.remoteSessions.delete('s1');
    expect(store.pushSubscriptions.bySession('s1')).toBeNull();
    expect(() => store.pushSubscriptions.put(sub({ sessionId: 'nobody' }))).toThrow(/FOREIGN KEY/);
  });
});

describe('SqlitePushSubscriptionRepo', () => {
  it('never syncs: no sync triggers, nothing in the change log, not a sync table, refused in a batch', () => {
    const db = freshDb();
    const store = new SqliteStore(db);
    store.remoteSessions.insert(session('s1'));
    const before = store.sync.latestSeq();

    store.pushSubscriptions.put(sub());
    store.pushSubscriptions.deleteBySession('s1');

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'push_subscription'").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE tbl = 'push_subscription'").get()).toEqual({ n: 0 });
    expect(store.sync.latestSeq()).toBe(before);
    expect(SYNC_TABLES as readonly string[]).not.toContain('push_subscription');
    expect(isSyncTable('push_subscription')).toBe(false);

    const planted = {
      tbl: 'push_subscription',
      id: 's1',
      op: 'upsert',
      hlc: '9999999999999-0000-peer',
      row: { session_id: 's1', endpoint: 'https://evil.example/', p256dh: 'x', auth: 'y', approvals: 1, replies: 1, scheduled: 1, created_at: 1, updated_at: 1 },
    } as unknown as ChangeRow;
    store.sync.apply([planted]);
    expect(store.pushSubscriptions.list()).toEqual([]);
  });
});
