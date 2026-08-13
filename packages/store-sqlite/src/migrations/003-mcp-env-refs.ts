import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.js';

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
// Existing rows have their plaintext env values discarded rather than
// "migrated forward" as refs: there is no SecretStore entry for them to
// reference, and inventing one from a value that was never meant to sit in
// this column doesn't improve on just resetting to the safe empty default,
// same precedent as migration 002. Discarding it silently, though, would
// mean the user's only credential for that server just vanished with no
// way to know why the server stopped connecting -- so this migration warns,
// by name, about every value it's about to drop, so the user knows to
// re-enter them via Settings > MCP Servers after upgrading.
//
// Simply overwriting the column is not enough to make the plaintext
// actually GO, either: `UPDATE mcp_server SET env_refs = '{}'` leaves the
// old row image sitting in a freed database page (and, under the WAL
// journaling `openDatabase` always enables, potentially in the WAL file
// too) until something else happens to overwrite it -- confirmed
// empirically by grepping the raw .db file for a planted secret right
// after this migration ran without the fix below, and finding it still
// there. `PRAGMA secure_delete` (set inside the migration's own
// transaction -- unlike `VACUUM`/`wal_checkpoint`, this pragma is NOT
// rejected inside one) makes SQLite overwrite freed content with zeros
// instead of just marking it reusable, but that alone only takes effect
// once something actually reclaims the freed space -- verified empirically
// that the plaintext can still linger in the WAL file until a checkpoint
// happens (e.g. on ordinary `close()`, or SQLite's own automatic
// checkpointing, neither of which is guaranteed to run promptly). So
// `postCommit` below forces the issue immediately: a `TRUNCATE` checkpoint
// (which also empties the WAL file, not just copies it back) followed by a
// `VACUUM` to rebuild the main file from only its live content. Both had to
// move to `postCommit` specifically because `runMigrations` runs this
// migration's `sql`/`run` inside `BEGIN`/`COMMIT`, and both throw ("database
// table is locked") if attempted while that transaction is still open --
// confirmed empirically, not assumed.

interface LegacyEnvRow {
  id: string;
  name: string;
  env_refs: string;
}

function droppedKeyNames(rawEnvRefs: string): string[] {
  try {
    const parsed = JSON.parse(rawEnvRefs) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

function warnAboutDroppedPlaintextEnv(db: DatabaseSync): void {
  const rows = db.prepare('SELECT id, name, env_refs FROM mcp_server').all() as unknown as LegacyEnvRow[];
  for (const row of rows) {
    const keys = droppedKeyNames(row.env_refs);
    if (keys.length === 0) continue;
    console.warn(
      `[migration 003-mcp-env-refs] MCP server "${row.name}" (${row.id}): dropping plaintext env value(s) for ` +
        `${keys.join(', ')} -- these predate SecretStore-backed env vars and cannot be migrated forward automatically. ` +
        'Re-enter them in Settings > MCP Servers after upgrading.'
    );
  }
}

export const MIGRATION_003_MCP_ENV_REFS: Migration = {
  version: 3,
  name: '003-mcp-env-refs',
  run(db: DatabaseSync): void {
    db.exec('ALTER TABLE mcp_server RENAME COLUMN env TO env_refs;');
    // See this file's header comment: safe to enable unconditionally, and
    // must happen before the UPDATE below to have any effect on the space
    // that UPDATE frees.
    db.exec('PRAGMA secure_delete = ON;');
    warnAboutDroppedPlaintextEnv(db);
    db.exec("UPDATE mcp_server SET env_refs = '{}';");
  },
  postCommit(db: DatabaseSync): void {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec('VACUUM;');
  },
};
