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

const OLD_HLC = '0000000000001-0000-peer';
const NEW_HLC = '9999999999999-0000-peer';

const tickRow = (over: Record<string, unknown> = {}, hlc = OLD_HLC): ChangeRow => {
  const row = { id: 'a1#7', app_id: 'a1', number: 7, through: '2026-10-01T00:00:00Z', updated_at: 1, ...over };
  return { tbl: 'issue_tick', id: row.id as string, op: 'upsert', hlc, row };
};

const stored = (n: ReturnType<typeof node>) => n.db.prepare("SELECT through, hlc FROM issue_tick WHERE id = 'a1#7'").get() as { through: string; hlc: string };

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

  it('set never lowers through, and an earlier one writes no change to sync', () => {
    const a = node('a');
    a.store.issueTicks.set('a1', 7, '2026-10-09T00:00:00Z');
    const cursor = a.store.sync.latestSeq();
    expect(a.store.issueTicks.set('a1', 7, '2026-10-01T00:00:00Z').through).toBe('2026-10-09T00:00:00Z');
    expect(a.store.issueTicks.list()).toMatchObject([{ through: '2026-10-09T00:00:00Z' }]);
    expect(a.store.sync.changesSince(cursor, 1000).rows).toEqual([]);
  });

  it("sync: a peer's earlier through never lowers this one, even with a newer stamp, and the stamp is still taken", () => {
    const b = node('b');
    b.store.issueTicks.set('a1', 7, '2026-10-09T00:00:00Z');
    expect(b.store.sync.apply([tickRow({ through: '2026-10-01T00:00:00Z' }, NEW_HLC)]).applied).toBe(1);
    expect(stored(b)).toEqual({ through: '2026-10-09T00:00:00Z', hlc: NEW_HLC });
  });

  it("sync: a peer's later through raises this one, even with an older stamp, and the newer stamp stays", () => {
    const b = node('b');
    b.store.issueTicks.set('a1', 7, '2026-10-01T00:00:00Z');
    const mine = stored(b).hlc;
    expect(b.store.sync.apply([tickRow({ through: '2026-10-09T00:00:00Z' }, OLD_HLC)]).applied).toBe(1);
    expect(stored(b)).toEqual({ through: '2026-10-09T00:00:00Z', hlc: mine });
  });

  it('sync: a row that changes neither the through nor the stamp is skipped', () => {
    const b = node('b');
    b.store.sync.apply([tickRow({ through: '2026-10-09T00:00:00Z' }, NEW_HLC)]);
    const cursor = b.store.sync.latestSeq();
    expect(b.store.sync.apply([tickRow({ through: '2026-10-01T00:00:00Z' }, OLD_HLC)])).toMatchObject({ applied: 0, skipped: 1 });
    expect(stored(b)).toEqual({ through: '2026-10-09T00:00:00Z', hlc: NEW_HLC });
    expect(b.store.sync.changesSince(cursor, 1000).rows).toEqual([]);
  });

  it('two machines ticking the same issue end on the later through, whichever wrote last', () => {
    const a = node('a');
    const b = node('b');
    a.store.issueTicks.set('a1', 7, '2026-10-09T00:00:00Z');
    // B ticks it through an earlier point after A did: B's stamp is the newer.
    b.store.issueTicks.set('a1', 7, '2026-10-01T00:00:00Z');
    const fromA = a.store.sync.changesSince(0, 1000).rows;
    const fromB = b.store.sync.changesSince(0, 1000).rows;
    a.store.sync.apply(fromB);
    b.store.sync.apply(fromA);
    for (let i = 0; i < 2; i++) {
      a.store.sync.apply(b.store.sync.changesSince(0, 1000).rows);
      b.store.sync.apply(a.store.sync.changesSince(0, 1000).rows);
    }
    expect(stored(a)).toEqual(stored(b));
    expect(stored(a).through).toBe('2026-10-09T00:00:00Z');
  });
});
