import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Migration } from './types.js';

// Migration 011: machines and portable folders (v2 plan, Task 42; spec §6).
//
// - `node_self` is this install's identity: one row, a random id, created
//   here and never again (a re-run skips the whole migration).
// - `location` is a named place ("Nextcloud") and `location_path` is where it
//   is on each machine, keyed by (location, machine).
// - A chat's (and a project's) folder is either location-relative
//   (`workspace_location_id` + `workspace_subpath`) or bound to one machine's
//   absolute path (`workspace_root` + `workspace_node`). Deleting a location
//   clears the folder of chats and projects using it (ON DELETE SET NULL);
//   it never deletes them.
// - `chat.runs_on` is the machine a chat's turns run on, and
//   `message.origin_node` the machine that wrote a message.
//
// Every existing folder, chat and message belongs to this machine, so the
// backfill binds them to the new self node.
export const MIGRATION_011_NODES_AND_LOCATIONS: Migration = {
  version: 11,
  name: '011-nodes-and-locations',
  sql: `
CREATE TABLE node_self (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE location (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE location_path (
  location_id TEXT NOT NULL REFERENCES location(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (location_id, node_id)
);
CREATE INDEX idx_location_path_node ON location_path(node_id);
ALTER TABLE chat ADD COLUMN workspace_location_id TEXT NULL REFERENCES location(id) ON DELETE SET NULL;
ALTER TABLE chat ADD COLUMN workspace_subpath TEXT NULL;
ALTER TABLE chat ADD COLUMN workspace_node TEXT NULL;
ALTER TABLE chat ADD COLUMN runs_on TEXT NULL;
CREATE INDEX idx_chat_workspace_location ON chat(workspace_location_id);
ALTER TABLE project ADD COLUMN workspace_location_id TEXT NULL REFERENCES location(id) ON DELETE SET NULL;
ALTER TABLE project ADD COLUMN workspace_subpath TEXT NULL;
ALTER TABLE project ADD COLUMN workspace_node TEXT NULL;
ALTER TABLE message ADD COLUMN origin_node TEXT NULL;
`,
  run: (db) => {
    const self = randomUUID();
    db.prepare('INSERT INTO node_self (id, name, created_at) VALUES (?, ?, ?)').run(self, hostname() || 'This machine', Date.now());
    db.prepare('UPDATE chat SET workspace_node = ? WHERE workspace_root IS NOT NULL').run(self);
    db.prepare('UPDATE project SET workspace_node = ? WHERE workspace_root IS NOT NULL').run(self);
    db.prepare('UPDATE chat SET runs_on = ?').run(self);
    db.prepare('UPDATE message SET origin_node = ?').run(self);
  },
};
