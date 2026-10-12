// Adds `usage.subagent_call_id`: set on a sub-agent's own usage row (spec
// 2026-10-12-api-subagents-design), the parent's `subagent` tool call id.
// Every existing row is a reply's own and stays NULL. Usage syncs as a
// whole row; an older build leaves the column alone when it syncs
// (`SqliteSyncRepo.upsert` writes only columns it knows).
export const MIGRATION_022_USAGE_SUBAGENT = `
ALTER TABLE usage ADD COLUMN subagent_call_id TEXT;
`;
