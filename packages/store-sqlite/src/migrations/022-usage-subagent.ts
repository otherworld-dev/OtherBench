// Adds `usage.subagent_call_id`: set on a sub-agent's own usage row (spec
// 2026-10-12-api-subagents-design), the parent's `subagent` tool call id.
// Every existing row is a reply's own and stays NULL. Peers on different
// schema versions refuse to sync (server peer/syncer.ts), so an older build
// never sees the column; if that gate is ever relaxed, `SqliteSyncRepo.upsert`
// writing only the columns it knows is the fallback.
export const MIGRATION_022_USAGE_SUBAGENT = `
ALTER TABLE usage ADD COLUMN subagent_call_id TEXT;
`;
