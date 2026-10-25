import { syncTriggers } from './013-change-tracking.js';
import type { Migration } from './types.js';

// Folders for the Code sidebar's apps (plan 2026-10-25-app-folders): one level,
// an app is in at most one folder. `app.folder_id` is deliberately not a
// foreign key, for the reason of migration 029: sync applies rows in no fixed
// order, so an app can arrive before its folder, and a real FK would refuse
// it. `SqliteAppFolderRepo.delete` clears `app.folder_id` itself (through the
// app repo, so the change syncs), and every reader treats a folder that is
// missing as none.
const byId = (row: 'NEW' | 'OLD'): string => `${row}.id`;

export const MIGRATION_032_APP_FOLDERS: Migration = {
  version: 32,
  name: '032-app-folders',
  sql: `
CREATE TABLE app_folder (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hlc TEXT NOT NULL DEFAULT ''
);
ALTER TABLE app ADD COLUMN folder_id TEXT NULL;
${syncTriggers({ table: 'app_folder', key: byId })}
`,
};
