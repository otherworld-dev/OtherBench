import type { DatabaseSync } from 'node:sqlite';

/**
 * One schema migration, applied by `runMigrations` (index.ts).
 *
 *  - `sql` runs inside this migration's own transaction (`BEGIN`/`COMMIT`,
 *    rolled back on any failure).
 *  - `run` is extra logic in that SAME transaction, after `sql`, for a
 *    migration that needs real control flow -- e.g. reading pre-migration
 *    rows to log a warning about data a purely-declarative SQL script
 *    would just discard silently (see 003-mcp-env-refs.ts).
 *  - `postCommit` runs immediately after this migration's transaction
 *    COMMITs, OUTSIDE any transaction -- for statements SQLite refuses to
 *    run inside one (`VACUUM`, `PRAGMA wal_checkpoint`; confirmed
 *    empirically -- both throw "database table is locked" if attempted
 *    inside `run`/`sql`). Only fires the run this migration is actually
 *    newly applied, never on a re-run against an already-migrated database.
 *
 * A migration needs only `sql` in the common case; `run`/`postCommit` exist
 * for the exceptional ones that can't be expressed as pure SQL.
 */
export interface Migration {
  version: number;
  name: string;
  sql?: string;
  run?: (db: DatabaseSync) => void;
  postCommit?: (db: DatabaseSync) => void;
}
