import { syncTriggers } from './013-change-tracking.js';
import type { Migration } from './types.js';

// Apps for the Code tab (spec 2026-10-20-code-tab-design, "Data"): a codebase's
// folder, the GitHub repo it came from, and an optional linked project whose
// memory and instructions its chats borrow. The folder columns are the ones a
// project has (migrations 007, 011), minus `folders`: an app's extra folders
// come only from its linked project.
//
// `app.linked_project_id` and `chat.app_id` are deliberately not foreign keys,
// for the reason of migration 027: sync applies rows in no fixed order, so a
// chat can arrive before its app and an app before its project, and a real FK
// would refuse them. `SqliteAppRepo.delete` clears `chat.app_id` itself
// (through the chat repo, so the change syncs), and every reader treats a
// linked project that is missing as none. `default_profile_id` is a real FK
// like the project's: profiles sync before apps.
const byId = (row: 'NEW' | 'OLD'): string => `${row}.id`;

export const MIGRATION_029_APPS: Migration = {
  version: 29,
  name: '029-apps',
  sql: `
CREATE TABLE app (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_location_id TEXT NULL REFERENCES location(id) ON DELETE SET NULL,
  workspace_subpath TEXT NULL,
  workspace_root TEXT NULL,
  workspace_node TEXT NULL,
  github_repo TEXT NULL,
  linked_project_id TEXT NULL,
  default_profile_id TEXT NULL REFERENCES profile(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hlc TEXT NOT NULL DEFAULT ''
);
ALTER TABLE chat ADD COLUMN app_id TEXT NULL;
CREATE INDEX idx_chat_app ON chat(app_id);
${syncTriggers({ table: 'app', key: byId })}
`,
};
