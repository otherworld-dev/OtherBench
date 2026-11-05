import type { Migration } from './types.js';

// Whether an app is shown in the Code sidebar (spec 2026-11-04-open-apps): the
// sidebar lists only open apps, so a long list of apps can be kept without
// crowding it. It syncs as part of the app row, so every machine shows the same
// open apps, and it travels with no change to sync beyond the 0/1 check.
// Existing apps stay visible: they default to open. Adding a column doesn't
// touch hlc, so nothing is logged for sync here.
export const MIGRATION_040_APP_OPEN: Migration = {
  version: 40,
  name: '040-app-open',
  sql: `
ALTER TABLE app ADD COLUMN open INTEGER NOT NULL DEFAULT 1;
`,
};
