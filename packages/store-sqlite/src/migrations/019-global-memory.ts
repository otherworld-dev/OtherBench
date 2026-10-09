import { syncTriggers } from './013-change-tracking.js';
import type { Migration } from './types.js';

// Global memory (spec 2026-10-08-global-memory-design): About you and the
// learned note, as two rows of `global_memory` keyed 'about' and 'note' so a
// change to one never overwrites the other when machines sync (rows merge
// whole). Both rows sync (migration 013's triggers); the note's version
// history stays on each machine, as project memory's does. Every existing
// chat's global cursor starts at its newest message, so upgrading never runs
// old history through the memory model, and every profile starts with
// global memory on.
export const MIGRATION_019_GLOBAL_MEMORY: Migration = {
  version: 19,
  name: '019-global-memory',
  sql: `
CREATE TABLE global_memory (
  key TEXT PRIMARY KEY CHECK (key IN ('about', 'note')),
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL CHECK (updated_by IN ('user', 'summariser')),
  source_chat_id TEXT NULL,
  hlc TEXT NOT NULL DEFAULT ''
);
CREATE TABLE global_memory_version (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  source_chat_id TEXT NULL
);
CREATE INDEX idx_global_memory_version_created ON global_memory_version(created_at);
ALTER TABLE chat ADD COLUMN global_memory_cursor TEXT NULL;
UPDATE chat SET global_memory_cursor = (SELECT id FROM message WHERE message.chat_id = chat.id ORDER BY created_at DESC, id DESC LIMIT 1);
ALTER TABLE profile ADD COLUMN use_global_memory INTEGER NOT NULL DEFAULT 1;
${syncTriggers({ table: 'global_memory', key: (row) => `${row}.key` })}
`,
};
