// Adds `grant.source` -- the `ToolSpec.source` ('fs' | 'shell' | 'mcp') of
// the tool a grant was created for.
//
// Grants used to be looked up by tool NAME alone, so two different tools
// sharing a name shared a grant. An MCP server chooses its own tool names,
// so a server-supplied tool called `run_command` could obtain a grant that
// the real, unsandboxed shell tool then matched -- the blanket always-grant
// the permission broker refuses to create for shell, obtained through a side
// door. `PermissionBroker.findMatchingGrant` now requires source to match as
// well as name.
//
// Existing rows (development databases only -- nothing has shipped) default
// to 'fs', deliberately the least dangerous value: an 'fs' grant can never
// authorise a shell or MCP tool, so any pre-existing shell grant simply stops
// matching and the next call asks the human again. Fail closed, not silently
// re-authorised under the new key.
export const MIGRATION_002_GRANT_SOURCE = `
ALTER TABLE "grant" ADD COLUMN source TEXT NOT NULL DEFAULT 'fs';
`;
