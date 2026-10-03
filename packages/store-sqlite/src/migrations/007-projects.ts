// Adds projects (spec 2026-10-03-projects-design §1): a `project` table and a
// nullable `chat.project_id`. ON DELETE SET NULL on both foreign keys is the
// required behaviour -- deleting a project never deletes its chats, and
// deleting a profile only clears it as a project's default. SQLite accepts a
// REFERENCES clause on ADD COLUMN because the column's default is NULL.
export const MIGRATION_007_PROJECTS = `
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_root TEXT NULL,
  default_profile_id TEXT NULL REFERENCES profile(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE chat ADD COLUMN project_id TEXT NULL REFERENCES project(id) ON DELETE SET NULL;
CREATE INDEX idx_chat_project ON chat(project_id);
`;
