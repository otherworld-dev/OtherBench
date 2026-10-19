import type { Migration } from './types.js';

// Adds two usage columns for the token-usage work:
//  - `tokens_cache_write`: input tokens written to the provider's prompt cache,
//    which cost more than plain input. Existing rows predate caching and are 0.
//  - `purpose`: set on the row of a call OtherBench made by itself about a
//    reply ('title', 'memory'); NULL on a reply's own row, as every existing
//    row is.
// Peers on different schema versions refuse to sync (server peer/syncer.ts),
// as for 026.
export const MIGRATION_028_USAGE_PURPOSE: Migration = {
  version: 28,
  name: '028-usage-purpose',
  run: (db) => {
    db.exec('ALTER TABLE usage ADD COLUMN tokens_cache_write INTEGER NOT NULL DEFAULT 0;');
    db.exec('ALTER TABLE usage ADD COLUMN purpose TEXT;');
  },
};
