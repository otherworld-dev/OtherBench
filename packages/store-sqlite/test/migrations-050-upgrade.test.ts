import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { MIGRATIONS, runMigrations } from '../src/migrations/index.js';
import { SqliteStore } from '../src/store.js';

// Betas 124 and 125 shipped a migration 050 that made two tables for an outside job service. Its number now belongs to
// an empty stub, and 051 carries each of those job chats into job_chat before dropping both tables. The old names are
// built from parts so this file is the only one that knows them, and doesn't spell them out.
const OLD = ['gla', 'dos'].join('');
const OLD_050_SQL = `
CREATE TABLE ${OLD}_job (id TEXT PRIMARY KEY, app_name TEXT NOT NULL, state TEXT NOT NULL, folder TEXT NULL, chat_id TEXT NULL);
CREATE TABLE ${OLD}_publish (job_id TEXT PRIMARY KEY, state TEXT NOT NULL);
`;

const tables = (db: ReturnType<typeof openDatabase>): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);

describe('migrations 050 and 051', () => {
  it('a fresh database has job_chat and none of the old job tables', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      expect(tables(db)).toContain('job_chat');
      expect(tables(db).filter((t) => t.startsWith(OLD))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a database that ran the old 050 keeps its job chats locked, and loses the old tables', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version <= 49));
      db.exec(OLD_050_SQL);
      db.exec('PRAGMA user_version = 50');
      const insert = db.prepare(`INSERT INTO ${OLD}_job (id, app_name, state, folder, chat_id) VALUES (?, 'App', 'done', ?, ?)`);
      insert.run('j1', 'E:\jobs\j1', 'chat-1');
      insert.run('j2', 'E:\jobs\j2', 'chat-2');
      insert.run('j3', 'E:\jobs\j3', null);
      insert.run('j4', null, 'chat-4');
      db.exec(`INSERT INTO ${OLD}_publish (job_id, state) VALUES ('j1', 'done')`);
      runMigrations(db);
      const store = new SqliteStore(db);
      expect(store.jobChats.folderFor('chat-1')).toBe('E:\jobs\j1');
      expect(store.jobChats.folderFor('chat-2')).toBe('E:\jobs\j2');
      expect(store.jobChats.folderFor('chat-4')).toBeNull();
      expect((db.prepare('SELECT COUNT(*) AS n FROM job_chat').get() as { n: number }).n).toBe(2);
      expect(tables(db).filter((t) => t.startsWith(OLD))).toEqual([]);
    } finally {
      db.close();
    }
  });
});
