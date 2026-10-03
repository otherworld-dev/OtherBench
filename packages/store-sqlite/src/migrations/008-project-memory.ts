// Adds project memory (spec 2026-10-03-project-memory-design §1): one current
// note per project and its version history (both cascade with the project),
// the per-chat summariser cursor and opt-out, and `app_setting`, a key/value
// table (JSON values) for app-wide settings. Grunt had no settings storage
// before this; `memoryProfileId` is its first key. `source_chat_id` has no
// foreign key on purpose: a note keeps naming the chat it came from after
// that chat is deleted (the UI shows "a deleted chat").
export const MIGRATION_008_PROJECT_MEMORY = `
CREATE TABLE project_memory (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL CHECK (updated_by IN ('user', 'summariser')),
  source_chat_id TEXT NULL
);
CREATE TABLE project_memory_version (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  source_chat_id TEXT NULL
);
CREATE INDEX idx_project_memory_version_project ON project_memory_version(project_id, created_at);
ALTER TABLE chat ADD COLUMN memory_cursor TEXT NULL;
ALTER TABLE chat ADD COLUMN memory_excluded INTEGER NOT NULL DEFAULT 0;
CREATE TABLE app_setting (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
