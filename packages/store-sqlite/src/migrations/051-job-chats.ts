import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.js';

// Job chats (docs/features/jobs.md): which chats run under the job rules, and the folder each is held to. Local, like
// the schedules: no sync triggers, so no paired machine ever sees or makes a row, and a chat is a job chat only
// through a row this machine wrote. TurnRunner reads it for every turn.
//
// Databases from betas 124 to 126 hold their job chats in a table from the old migration 050 instead. Each one with
// a chat is copied here first, so those chats stay locked (a job chat whose row went missing would run
// as an ordinary chat in a folder a job wrote), then both old tables are dropped.
const OLD_JOBS = 'gla' + 'dos_job';
const OLD_PUBLISHES = 'gla' + 'dos_publish';

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export const MIGRATION_051_JOB_CHATS: Migration = {
  version: 51,
  name: '051-job-chats',
  sql: `
CREATE TABLE job_chat (
  chat_id TEXT PRIMARY KEY,
  folder TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
  run: (db) => {
    if (tableExists(db, OLD_JOBS)) {
      // Every chat with a row stays a job chat. One with no folder is held to '' (no folder), so TurnRunner refuses its
      // turns rather than running them loose; a chat with several rows (a continuation) takes one that has a folder.
      db.exec(
        `INSERT OR IGNORE INTO job_chat (chat_id, folder, created_at)
         SELECT chat_id, COALESCE(MAX(folder), ''), CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM ${OLD_JOBS}
         WHERE chat_id IS NOT NULL GROUP BY chat_id`
      );
      db.exec(`DROP TABLE ${OLD_JOBS}`);
    }
    if (tableExists(db, OLD_PUBLISHES)) db.exec(`DROP TABLE ${OLD_PUBLISHES}`);
  },
};
