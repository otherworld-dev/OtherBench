import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.js';

// Adds `mcp_server.oauth`: an http MCP server's sign-in summary (spec
// 2026-10-12-mcp-oauth-design §2) -- a hand-registered client ID, the
// SecretStore reference of its secret, "signed in as" and when. Never a
// token: those stay in SecretStore. `mcp_server` isn't a synced table
// (migration 013's TRACKED_TABLES), so sign-ins stay on this machine.
//
// This migration was 022 on feat/remote-access-build and 024 on this branch
// before live artifacts were merged. A dev database from either already has
// the column but a lower user_version, so it would reach here having skipped
// a migration this branch numbers below it. That is refused with a pointer
// to the fix, never passed over quietly: skipping would leave the other
// migration's column missing for good.
export const MCP_OAUTH_ALREADY_THERE =
  'Migration 025-mcp-oauth: mcp_server.oauth already exists, so this database was migrated under an older numbering ' +
  '(feat/remote-access-build, or this branch before live artifacts) and has skipped a migration. Nothing was changed. ' +
  'See "Integration (feat/cowork-parity-all)" in docs/HANDOVER.md for how to fix it.';

function hasOauthColumn(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 AS found FROM pragma_table_info('mcp_server') WHERE name = 'oauth'").get() !== undefined;
}

export const MIGRATION_025_MCP_OAUTH: Migration = {
  version: 25,
  name: '025-mcp-oauth',
  run: (db) => {
    if (hasOauthColumn(db)) throw new Error(MCP_OAUTH_ALREADY_THERE);
    db.exec('ALTER TABLE mcp_server ADD COLUMN oauth TEXT;');
  },
};
