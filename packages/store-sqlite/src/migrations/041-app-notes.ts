import { syncTriggers } from './013-change-tracking.js';
import type { Migration } from './types.js';

// App notes (spec 2026-11-05-app-notes-design): an app's standing facts, one
// row per app. The row syncs (an app's notes are the same on every machine);
// `mirrored_at`, this machine's last good write to Collectives, and the
// version history stay on this machine, as project memory's history does.
// `app_id` is a real foreign key like `project_memory.project_id`: sync
// applies `app` before `app_notes`, and a row for a missing app is refused.
export const MIGRATION_041_APP_NOTES: Migration = {
  version: 41,
  name: '041-app-notes',
  sql: `
CREATE TABLE app_notes (
  app_id TEXT PRIMARY KEY REFERENCES app(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  source_chat_id TEXT NULL,
  mirrored_at INTEGER NULL,
  hlc TEXT NOT NULL DEFAULT ''
);
CREATE TABLE app_notes_version (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source_chat_id TEXT NULL
);
CREATE INDEX idx_app_notes_version_app ON app_notes_version(app_id, created_at);
${syncTriggers({ table: 'app_notes', key: (row) => `${row}.app_id` })}
`,
};
