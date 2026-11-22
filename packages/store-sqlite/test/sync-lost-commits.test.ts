import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';
import { runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

// With `synchronous = NORMAL` a power cut can take the last few commits with
// it. Another machine may already have pulled them, so its cursor is past the
// end of what is left of this machine's change log: changes made after the
// restart must not be numbered at or below that cursor, or it never asks for them.

function open(db: DatabaseSync, id: string): SqliteStore {
  db.prepare('UPDATE node_self SET id = ?').run(id);
  return new SqliteStore(db);
}

function fresh(): DatabaseSync {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

describe('a change log that lost its newest entries', () => {
  it('numbers changes made after a restart past anything another machine can have pulled', () => {
    const dbA = fresh();
    let a = open(dbA, 'a');
    const b = open(fresh(), 'b');
    a.locations.create({ id: 'l1', name: 'One' });
    a.locations.create({ id: 'l2', name: 'Two' });
    a.locations.create({ id: 'l3', name: 'Three' });
    const first = a.sync.changesSince(0, 1000);
    b.sync.apply(first.rows);
    const cursor = first.nextSeq;

    // The power goes: a's last two commits never reached the disk, and the log's numbering goes back with them.
    dbA.exec("DELETE FROM location WHERE id IN ('l2', 'l3')");
    const kept = (dbA.prepare("SELECT MAX(seq) AS seq FROM change_log WHERE row_id = 'l1'").get() as { seq: number }).seq;
    dbA.prepare('DELETE FROM change_log WHERE seq > ?').run(kept);
    dbA.prepare("DELETE FROM tombstone WHERE tbl = 'location'").run();
    dbA.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'change_log'").run(kept);
    expect(a.sync.latestSeq()).toBeLessThan(cursor);

    // It starts again and something new is made.
    a = open(dbA, 'a');
    a.locations.create({ id: 'l4', name: 'Four' });

    const next = a.sync.changesSince(cursor, 1000);
    expect(next.rows.map((r) => r.id)).toEqual(['l4']);
    b.sync.apply(next.rows);
    expect(b.locations.get('l4')).toMatchObject({ name: 'Four' });
    // And what a lost comes back from the machine that had pulled it.
    a.sync.apply(b.sync.changesSince(0, 1000).rows);
    expect(a.locations.list().map((l) => l.id).sort()).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it('does so on a log that has no entries yet', () => {
    const db = fresh();
    db.exec('DELETE FROM change_log');
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'change_log'");
    const a = open(db, 'a');
    a.locations.create({ id: 'l1', name: 'One' });
    expect(a.sync.changesSince(5000, 1000).rows.map((r) => r.id)).toEqual(['l1']);
  });
});
