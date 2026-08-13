// Migration 003: `mcp_server.env` -> `mcp_server.env_refs`.
//
// `env` used to hold each stdio MCP server's environment variables as
// plaintext JSON, the one place in the schema that stored user-supplied
// credential material directly instead of a `SecretStore` reference --
// every comparable field (`connection.secret_ref`, `mcp_server.header_refs`)
// already followed "never plaintext at rest". A stdio MCP server's env vars
// are exactly as likely to carry a credential as its HTTP counterpart's
// headers (e.g. `GITHUB_TOKEN=...`), so this closes that gap by bringing env
// in line with headers: renamed to `env_refs`, and from this migration
// forward the route layer (routes/tools.ts) writes each value to
// `SecretStore` and persists only the resulting reference here, exactly as
// it already does for `header_refs`.
//
// Existing rows (development databases only -- nothing has shipped) have
// their plaintext env values discarded rather than "migrated forward" as
// refs: there is no SecretStore entry for them to reference, and inventing
// one from a value that was never meant to sit in this column doesn't
// improve on just resetting to the safe empty default, same precedent as
// migration 002.
export const MIGRATION_003_MCP_ENV_REFS = `
ALTER TABLE mcp_server RENAME COLUMN env TO env_refs;
UPDATE mcp_server SET env_refs = '{}';
`;
