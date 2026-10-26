import { describe, expect, it } from 'vitest';
import type { ChangeRow } from '@otherbench/core/domain/sync.js';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

function node(id: string) {
  const db = openDatabase(':memory:');
  runMigrations(db);
  db.prepare('UPDATE node_self SET id = ?').run(id);
  return { db, store: new SqliteStore(db) };
}

const tickRow = (over: Record<string, unknown> = {}): ChangeRow => {
  const row = { id: 'a1#7', app_id: 'a1', number: 7, through: '2026-10-01T00:00:00Z', updated_at: 1, ...over };
  return { tbl: 'issue_tick', id: row.id as string, op: 'upsert', hlc: '0000000000001-0000-peer', row };
};

describe('issue ticks', () => {
  it('sync: a tick set on A arrives on B, and a later through replaces it there', () => {
    const a = node('a');
    const b = node('b');
    a.store.issueTicks.set('a1', 7, '2026-10-01T00:00:00Z');
    b.store.sync.apply(a.store.sync.changesSince(0, 1000).rows);
    expect(b.store.issueTicks.list()).toMatchObject([{ appId: 'a1', number: 7, through: '2026-10-01T00:00:00Z' }]);

    const cursor = a.store.sync.latestSeq();
    a.store.issueTicks.set('a1', 7, '2026-10-09T00:00:00Z');
    b.store.sync.apply(a.store.sync.changesSince(cursor, 1000).rows);
    expect(b.store.issueTicks.list()).toMatchObject([{ through: '2026-10-09T00:00:00Z' }]);
  });

  it('deleting an app syncs its ticks as tombstones', () => {
    const a = node('a');
    const b = node('b');
    a.store.apps.create({ id: 'a1', name: 'One' });
    a.store.issueTicks.set('a1', 7, '2026-10-01T00:00:00Z');
    b.store.sync.apply(a.store.sync.changesSince(0, 1000).rows);
    const cursor = a.store.sync.latestSeq();
    a.store.apps.delete('a1');
    expect((a.db.prepare("SELECT row_id FROM tombstone WHERE tbl = 'issue_tick'").all() as { row_id: string }[]).map((r) => r.row_id)).toEqual(['a1#7']);
    b.store.sync.apply(a.store.sync.changesSince(cursor, 1000).rows);
    expect(b.store.issueTicks.list()).toEqual([]);
  });

  it('sync apply takes a valid row and refuses a mismatched id, a non-positive or fractional number, and an unparseable through', () => {
    const b = node('b');
    b.store.sync.apply([tickRow()]);
    expect(b.store.issueTicks.list()).toHaveLength(1);

    const bad: Record<string, unknown>[] = [
      { id: 'a1#8' },
      { id: 'a1#0', number: 0 },
      { id: 'a1#-1', number: -1 },
      { id: 'a1#1.5', number: 1.5 },
      { id: 'a2#7', number: 7, through: 'not a date' },
      { id: 'a2#7', app_id: 'a2', number: '7' },
    ];
    for (const over of bad) b.store.sync.apply([tickRow(over)]);
    expect(b.store.issueTicks.list()).toHaveLength(1);
  });
});
