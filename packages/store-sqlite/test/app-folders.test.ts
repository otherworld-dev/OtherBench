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

const folderRow = (id: string, over: Record<string, unknown> = {}): ChangeRow => ({
  tbl: 'app_folder',
  id,
  op: 'upsert',
  hlc: '0000000000001-0000-peer',
  row: { id, name: 'Work', sort_order: 0, created_at: 1, updated_at: 1, ...over },
});

describe('app folders', () => {
  it('deleting a folder writes a change row for each app it cleared, and a tombstone for the folder', () => {
    const a = node('a');
    a.store.appFolders.create({ id: 'f1', name: 'Work' });
    a.store.apps.create({ id: 'a1', name: 'One', folderId: 'f1' });
    a.store.apps.create({ id: 'a2', name: 'Two' });
    const before = a.store.sync.latestSeq();

    a.store.appFolders.delete('f1');

    const log = a.db.prepare('SELECT tbl, op, row_id FROM change_log WHERE seq > ? ORDER BY seq').all(before) as { tbl: string; op: string; row_id: string }[];
    expect(log.map((r) => ({ ...r }))).toEqual([
      { tbl: 'app', op: 'upsert', row_id: 'a1' },
      { tbl: 'app_folder', op: 'delete', row_id: 'f1' },
    ]);
    expect((a.db.prepare("SELECT row_id FROM tombstone WHERE tbl = 'app_folder'").all() as { row_id: string }[]).map((r) => r.row_id)).toEqual(['f1']);
  });

  it('sync: a folder and its app arrive on the other machine, and deleting the folder clears the app there', () => {
    const a = node('a');
    const b = node('b');
    a.store.appFolders.create({ id: 'f1', name: 'Work' });
    a.store.apps.create({ id: 'a1', name: 'One', folderId: 'f1' });
    b.store.sync.apply(a.store.sync.changesSince(0, 1000).rows);
    expect(b.store.appFolders.get('f1')).toMatchObject({ name: 'Work' });
    expect(b.store.apps.get('a1')!.folderId).toBe('f1');

    const cursor = a.store.sync.latestSeq();
    a.store.appFolders.delete('f1');
    b.store.sync.apply(a.store.sync.changesSince(cursor, 1000).rows);
    expect(b.store.appFolders.get('f1')).toBeNull();
    expect(b.store.apps.get('a1')!.folderId).toBeNull();
  });

  it('sync apply takes a valid folder row (100 characters is fine) and refuses 101, empty, blank, fractional-position and non-string names', () => {
    const b = node('b');
    b.store.sync.apply([folderRow('f1'), folderRow('f2', { name: 'x'.repeat(100) })]);
    expect(b.store.appFolders.get('f1')).toMatchObject({ name: 'Work' });
    expect(b.store.appFolders.get('f2')).not.toBeNull();

    const bad: [string, Record<string, unknown>][] = [
      ['f3', { name: 'x'.repeat(101) }],
      ['f4', { name: '' }],
      ['f5', { name: '   ' }],
      ['f6', { sort_order: 1.5 }],
      ['f7', { name: 7 }],
    ];
    for (const [id, over] of bad) {
      b.store.sync.apply([folderRow(id, over)]);
      expect(b.store.appFolders.get(id)).toBeNull();
    }
  });

  it('sync apply keeps an app whose folder_id names no folder, and refuses a non-string folder_id', () => {
    const a = node('a');
    const b = node('b');
    a.store.apps.create({ id: 'a1', name: 'One', folderId: 'missing' });
    const rows = a.store.sync.changesSince(0, 1000).rows.filter((r) => r.tbl === 'app');
    b.store.sync.apply(rows);
    expect(b.store.apps.get('a1')!.folderId).toBe('missing');

    const bad = rows.map((r) => (r.op === 'upsert' ? { ...r, id: 'a2', row: { ...r.row, id: 'a2', folder_id: 5 } } : r));
    b.store.sync.apply(bad);
    expect(b.store.apps.get('a2')).toBeNull();
  });
});
