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

describe('app open', () => {
  it('create defaults open to true, and takes open: false', () => {
    const { store } = node('a');
    expect(store.apps.create({ id: 'a1', name: 'One' }).open).toBe(true);
    expect(store.apps.create({ id: 'a2', name: 'Two', open: false }).open).toBe(false);
    expect(store.apps.get('a2')!.open).toBe(false);
  });

  it('update writes open and logs a change row', () => {
    const { db, store } = node('a');
    store.apps.create({ id: 'a1', name: 'One' });
    const before = store.sync.latestSeq();

    store.apps.update('a1', { open: false, updatedAt: 5 });

    expect(store.apps.get('a1')!.open).toBe(false);
    const rows = store.sync.changesSince(before, 1000).rows.filter((r): r is Extract<ChangeRow, { op: 'upsert' }> => r.tbl === 'app' && r.op === 'upsert');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row['open']).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM change_log WHERE seq > ?').get(before) as { n: number }).n).toBe(1);
  });

  it('sync applies open', () => {
    const a = node('a');
    const b = node('b');
    a.store.apps.create({ id: 'a1', name: 'One', open: false });
    b.store.sync.apply(a.store.sync.changesSince(0, 1000).rows);
    expect(b.store.apps.get('a1')!.open).toBe(false);
  });

  it('sync refuses an app row whose open is not 0 or 1', () => {
    const a = node('a');
    const b = node('b');
    a.store.apps.create({ id: 'a1', name: 'One' });
    const rows = a.store.sync.changesSince(0, 1000).rows.filter((r): r is ChangeRow => r.tbl === 'app');
    let n = 0;
    for (const bad of [2, '1', null]) {
      const id = `bad${n++}`;
      b.store.sync.apply(rows.map((r) => (r.op === 'upsert' ? { ...r, id, row: { ...r.row, id, open: bad } } : r)));
      expect(b.store.apps.get(id)).toBeNull();
    }
    b.store.sync.apply(rows);
    expect(b.store.apps.get('a1')!.open).toBe(true);
  });
});
