// Adds `mcp_server.oauth`: an http MCP server's sign-in summary (spec
// 2026-10-12-mcp-oauth-design §2) -- a hand-registered client ID, the
// SecretStore reference of its secret, "signed in as" and when. Never a
// token: those stay in SecretStore. `mcp_server` isn't a synced table
// (migration 013's TRACKED_TABLES), so sign-ins stay on this machine.
export const MIGRATION_022_MCP_OAUTH = `
ALTER TABLE mcp_server ADD COLUMN oauth TEXT;
`;
