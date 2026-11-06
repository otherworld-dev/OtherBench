import type { Migration } from './types.js';

// A profile's browser site list (Profile.browserAllowedSites): websites its
// chats' browser may use without a card, as a JSON array of canonical entries
// (`example.com`, `*.example.com`). Every profile made before gets an empty
// list, which changes nothing. `profile` already syncs (migration 013's
// triggers fire on every stamped update, whatever the column), and sync copies
// a row's columns as the table has them, so the list travels between paired
// machines with the rest of the profile and needs no trigger change here.
export const MIGRATION_042_PROFILE_BROWSER_SITES: Migration = {
  version: 42,
  name: '042-profile-browser-sites',
  sql: `
ALTER TABLE profile ADD COLUMN browser_allowed_sites TEXT NOT NULL DEFAULT '[]';
`,
};
