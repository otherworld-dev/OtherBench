import type { Migration } from './types.js';

// An app's Nextcloud links (spec 2026-10-22-nextcloud-tabs): the Deck board
// (by numeric id), the Collectives page (collective + path) and the Bookmarks
// tag behind the Code tab's Deck, Wiki and Links tabs. All nullable, so
// existing apps have none set; like `linked_project_id` they are plain
// columns, and sync copies them via PRAGMA table_info.
export const MIGRATION_030_APP_NEXTCLOUD: Migration = {
  version: 30,
  name: '030-app-nextcloud',
  run: (db) => {
    db.exec(`
      ALTER TABLE app ADD COLUMN deck_board_id INTEGER NULL;
      ALTER TABLE app ADD COLUMN wiki_collective TEXT NULL;
      ALTER TABLE app ADD COLUMN wiki_page_path TEXT NULL;
      ALTER TABLE app ADD COLUMN bookmark_tag TEXT NULL;
    `);
  },
};
