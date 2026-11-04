import type { Migration } from './types.js';

// When a message stopped being written (ms): set as a reply leaves streaming
// (SqliteMessageRepo.updateStatus), so the sidebar's Needs you list can order
// chats by when they came to need the user, and keep that order across
// reloads and restarts. A message syncs as a whole row, so it travels to
// paired machines with no change to sync. Existing messages don't know theirs:
// null, and their created_at stands in. Adding a column doesn't touch hlc, so
// nothing is logged for sync here.
export const MIGRATION_036_MESSAGE_FINISHED_AT: Migration = {
  version: 36,
  name: '036-message-finished-at',
  sql: `
ALTER TABLE message ADD COLUMN finished_at INTEGER;
`,
};
