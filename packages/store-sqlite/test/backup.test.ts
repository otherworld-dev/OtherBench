import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { backupBeforeMigration } from '../src/backup.js';

const base = mkdtempSync(join(tmpdir(), 'otherbench-backup-'));
afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    // ignore cleanup races
  }
});

let n = 0;
/** A database file at `version`, with a row written after a checkpoint so it sits only in the WAL. */
function databaseAt(version: number): { dir: string; path: string; db: ReturnType<typeof openDatabase> } {
  const dir = join(base, `d${n++}`);
  mkdirSync(dir);
  const path = join(dir, 'otherbench.db');
  const db = openDatabase(path);
  db.exec('CREATE TABLE t (v TEXT)');
  db.exec("INSERT INTO t VALUES ('in the file')");
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec("INSERT INTO t VALUES ('only in the WAL')");
  db.exec(`PRAGMA user_version = ${version}`);
  return { dir, path, db };
}

function userVersion(db: ReturnType<typeof openDatabase>): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

describe('backupBeforeMigration', () => {
  it('copies a database at version 33 to <db>.before-schema-33 before it moves to 34', () => {
    const { path, db } = databaseAt(33);
    const copy = backupBeforeMigration(db, path, 34);
    db.close();
    expect(copy).toBe(`${path}.before-schema-33`);
    const opened = openDatabase(copy!);
    try {
      expect(userVersion(opened)).toBe(33);
      expect(opened.prepare('SELECT v FROM t ORDER BY rowid').all().map((r) => (r as { v: string }).v)).toEqual(['in the file', 'only in the WAL']);
    } finally {
      opened.close();
    }
  });

  it('copies nothing for a new database, an up-to-date one or :memory:', () => {
    const fresh = databaseAt(0);
    expect(backupBeforeMigration(fresh.db, fresh.path, 34)).toBeNull();
    fresh.db.close();
    const current = databaseAt(34);
    expect(backupBeforeMigration(current.db, current.path, 34)).toBeNull();
    current.db.close();
    for (const { dir } of [fresh, current]) expect(readdirSync(dir).filter((f) => f.includes('before-schema'))).toEqual([]);
    const memory = openDatabase(':memory:');
    memory.exec('PRAGMA user_version = 5');
    expect(backupBeforeMigration(memory, ':memory:', 34)).toBeNull();
    memory.close();
  });

  it('keeps only the newest three copies', () => {
    const { dir, path, db } = databaseAt(9);
    for (const v of [9, 10, 11, 12]) {
      db.exec(`PRAGMA user_version = ${v}`);
      backupBeforeMigration(db, path, 13);
    }
    db.close();
    expect(readdirSync(dir).filter((f) => f.includes('before-schema')).sort()).toEqual([
      'otherbench.db.before-schema-10',
      'otherbench.db.before-schema-11',
      'otherbench.db.before-schema-12',
    ]);
  });

  it("refuses to go on when the copy can't be written", () => {
    const { path, db } = databaseAt(33);
    mkdirSync(`${path}.before-schema-33`);
    try {
      expect(() => backupBeforeMigration(db, path, 34)).toThrow(/Could not copy the database before upgrading it/);
      expect(userVersion(db)).toBe(33);
    } finally {
      db.close();
    }
    expect(existsSync(`${path}.before-schema-33`)).toBe(true);
  });
});
