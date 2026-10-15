import type { Migration } from './types.js';

// Adds `project.parent_id`: a sub-project's parent (spec
// 2026-10-15-sub-projects-design §1). Deliberately not a foreign key: sync
// applies project rows in no fixed order, so a sub-project can arrive before
// its parent, and a real FK would refuse it. `SqliteProjectRepo.delete`
// clears its sub-projects' links instead of ON DELETE SET NULL, and every
// reader goes through `projectParentOf`, which treats a missing or nested
// parent as none.
export const MIGRATION_027_PROJECT_PARENT: Migration = {
  version: 27,
  name: '027-project-parent',
  run: (db) => {
    db.exec(`
      ALTER TABLE project ADD COLUMN parent_id TEXT;
      CREATE INDEX idx_project_parent ON project(parent_id);
    `);
  },
};
