import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.js';

// Adds `usage.subagent_call_id`: set on a sub-agent's own usage row (spec
// 2026-10-12-api-subagents-design), the parent's `subagent` tool call id.
// Every existing row is a reply's own and stays NULL. Peers on different
// schema versions refuse to sync (server peer/syncer.ts), so an older build
// never sees the column; if that gate is ever relaxed, `SqliteSyncRepo.upsert`
// writing only the columns it knows is the fallback.
//
// This migration was 022 on feat/office-files-build (the sub-agents work). A
// dev database from there already has the column at user_version 22, so here
// it skips 022-chat-plan-mode, runs 023 to 025 and then reaches this one. That
// is refused with a pointer to the fix, as 025-mcp-oauth does, never passed
// over quietly: skipping would leave chat.plan_mode missing for good.
export const USAGE_SUBAGENT_ALREADY_THERE =
  'Migration 026-usage-subagent: usage.subagent_call_id already exists, so this database was migrated under an older numbering ' +
  '(feat/office-files-build with sub-agents, where this was 022) and has skipped a migration. Nothing was changed by this migration. ' +
  'See "Integration (feat/cowork-parity-all)" in docs/HANDOVER.md for how to fix it.';

function hasSubagentColumn(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 AS found FROM pragma_table_info('usage') WHERE name = 'subagent_call_id'").get() !== undefined;
}

export const MIGRATION_026_USAGE_SUBAGENT: Migration = {
  version: 26,
  name: '026-usage-subagent',
  run: (db) => {
    if (hasSubagentColumn(db)) throw new Error(USAGE_SUBAGENT_ALREADY_THERE);
    db.exec('ALTER TABLE usage ADD COLUMN subagent_call_id TEXT;');
  },
};
