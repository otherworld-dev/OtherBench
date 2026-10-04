import type { DatabaseSync } from 'node:sqlite';
import { MIGRATION_001_INITIAL } from './001-initial.js';
import { MIGRATION_002_GRANT_SOURCE } from './002-grant-source.js';
import { MIGRATION_003_MCP_ENV_REFS } from './003-mcp-env-refs.js';
import { MIGRATION_004_ATTACHMENT_SHA256_INDEX } from './004-attachment-sha256-index.js';
import { MIGRATION_005_MESSAGE_ENGINE_META } from './005-message-engine-meta.js';
import { MIGRATION_006_CHAT_AUTO_MODE } from './006-chat-auto-mode.js';
import { MIGRATION_007_PROJECTS } from './007-projects.js';
import { MIGRATION_008_PROJECT_MEMORY } from './008-project-memory.js';
import { MIGRATION_009_MESSAGE_KEPT_AT } from './009-message-kept-at.js';
import type { Migration } from './types.js';

export type { Migration } from './types.js';

export const MIGRATIONS: Migration[] = [
  { version: 1, name: '001-initial', sql: MIGRATION_001_INITIAL },
  { version: 2, name: '002-grant-source', sql: MIGRATION_002_GRANT_SOURCE },
  MIGRATION_003_MCP_ENV_REFS,
  { version: 4, name: '004-attachment-sha256-index', sql: MIGRATION_004_ATTACHMENT_SHA256_INDEX },
  { version: 5, name: '005-message-engine-meta', sql: MIGRATION_005_MESSAGE_ENGINE_META },
  { version: 6, name: '006-chat-auto-mode', sql: MIGRATION_006_CHAT_AUTO_MODE },
  { version: 7, name: '007-projects', sql: MIGRATION_007_PROJECTS },
  { version: 8, name: '008-project-memory', sql: MIGRATION_008_PROJECT_MEMORY },
  { version: 9, name: '009-message-kept-at', sql: MIGRATION_009_MESSAGE_KEPT_AT },
];

/**
 * Applies every migration in `migrations` (defaults to {@link MIGRATIONS})
 * whose version is greater than the database's current `PRAGMA user_version`,
 * in ascending version order. Each migration's `sql`/`run` (see
 * {@link Migration}) execute inside their own transaction: a failure rolls
 * back that migration's statements entirely and the error propagates,
 * leaving `user_version` at whatever it was before that migration started.
 * A migration's `postCommit`, if any, then runs immediately after --
 * outside that transaction, since SQLite refuses some statements
 * (`VACUUM`, `PRAGMA wal_checkpoint`) inside one. Re-running with nothing
 * pending is a no-op.
 *
 * A `postCommit` failure (disk pressure, or another process holding the
 * database for `VACUUM`/`wal_checkpoint`) is caught and logged rather than
 * left to propagate: the migration's own transaction already committed by
 * this point (`user_version` was already advanced), so throwing here would
 * fail `createContainer`/server startup for something that, unlike the
 * migration itself, is NOT required for correctness of the schema -- e.g.
 * migration 003's postCommit only scrubs plaintext residue left behind by
 * the migration, it doesn't change any row's live value. Re-running
 * `runMigrations` after a `postCommit` failure will NOT retry it: the
 * migration's version is already <= the database's `user_version`, so the
 * loop skips it entirely on the next run. That's why this is logged loudly
 * (naming the migration and what was skipped) instead of swallowed --
 * silently sailing through would otherwise leave a user with no way to
 * know the scrub never happened.
 */
export function runMigrations(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const currentVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;

  for (const migration of sorted) {
    if (migration.version <= currentVersion) continue;

    db.exec('BEGIN');
    try {
      if (migration.sql) db.exec(migration.sql);
      migration.run?.(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    if (migration.postCommit) {
      try {
        migration.postCommit(db);
      } catch (err) {
        console.error(
          `[migrations] Migration ${migration.version} (${migration.name}) committed successfully, but its ` +
            `postCommit step failed and was skipped: ${err instanceof Error ? err.message : String(err)}. ` +
            'Startup is continuing -- the migration itself is applied -- but whatever postCommit does for this ' +
            'migration (see its own comments) did NOT run, and will NOT be retried automatically: the migration ' +
            'will not re-apply on a future startup. If this is migration 003, plaintext env values dropped by the ' +
            'rename may still be recoverable from the database/WAL files on disk until something else reclaims ' +
            'that space -- investigate the error above, then re-run its postCommit manually if needed.',
          err
        );
      }
    }
  }
}
