import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { runMigrations, MIGRATIONS, type Migration } from '../src/migrations/index.js';
import type { DatabaseSync } from 'node:sqlite';

function freshDb(): DatabaseSync {
  return openDatabase(':memory:');
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as {
    name: string;
  }[]).map((r) => r.name);
}

describe('runMigrations', () => {
  it('brings a fresh database to the latest migration version', () => {
    const db = freshDb();
    try {
      expect(userVersion(db)).toBe(0);
      runMigrations(db);
      expect(userVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    } finally {
      db.close();
    }
  });

  it('002 gives every grant row a source column, defaulting pre-existing rows to the harmless value', () => {
    // Grants are matched on source as well as tool name (see
    // domain/permissions.ts); a row that predates the column must not come
    // back as a shell grant. 'fs' is the deliberate default: it can never
    // authorise a shell or mcp tool, so an old shell grant simply stops
    // matching and the next call asks again.
    const db = freshDb();
    try {
      runMigrations(db, [MIGRATIONS[0]!]);
      db.exec(`INSERT INTO "grant" (id, chat_id, profile_id, tool_name, scope, "constraint", expires_at)
               VALUES ('legacy', NULL, NULL, 'run_command', 'always', NULL, NULL)`);
      runMigrations(db);
      const row = db.prepare(`SELECT source FROM "grant" WHERE id = 'legacy'`).get() as { source: string };
      expect(row.source).toBe('fs');
    } finally {
      db.close();
    }
  });

  it('003 renames mcp_server.env to env_refs and resets pre-existing plaintext values to the empty default', () => {
    // env used to hold plaintext env var values; there is no SecretStore
    // entry for a pre-existing row's old plaintext to become a ref to, so
    // (same precedent as 002) it is reset to the safe empty default rather
    // than "migrated forward" as a fake ref.
    const db = freshDb();
    try {
      runMigrations(db, [MIGRATIONS[0]!]);
      db.exec(`INSERT INTO mcp_server (id, name, transport, env, header_refs)
               VALUES ('legacy', 'Legacy Srv', 'stdio', '{"API_KEY":"plaintext-value"}', '{}')`);
      runMigrations(db);
      const row = db.prepare(`SELECT env_refs FROM mcp_server WHERE id = 'legacy'`).get() as { env_refs: string };
      expect(row.env_refs).toBe('{}');
    } finally {
      db.close();
    }
  });

  it('003 warns, by server name and variable name, about every plaintext env value it drops', () => {
    const db = freshDb();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      runMigrations(db, [MIGRATIONS[0]!]);
      db.exec(`INSERT INTO mcp_server (id, name, transport, env, header_refs)
               VALUES ('legacy', 'Legacy Srv', 'stdio', '{"GITHUB_TOKEN":"ghp_secret","KEEP":"also-secret"}', '{}')`);
      db.exec(`INSERT INTO mcp_server (id, name, transport, env, header_refs)
               VALUES ('empty', 'Empty Srv', 'stdio', '{}', '{}')`);
      runMigrations(db);

      const warnings = warnSpy.mock.calls.map((call) => String(call[0]));
      const legacyWarning = warnings.find((w) => w.includes('Legacy Srv'));
      expect(legacyWarning).toBeDefined();
      expect(legacyWarning).toContain('legacy');
      expect(legacyWarning).toContain('GITHUB_TOKEN');
      expect(legacyWarning).toContain('KEEP');
      // A server with nothing to drop gets no warning.
      expect(warnings.some((w) => w.includes('Empty Srv'))).toBe(false);
    } finally {
      warnSpy.mockRestore();
      db.close();
    }
  });

  describe('003 plaintext residue', () => {
    let dir: string;
    afterEach(() => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup races
      }
    });

    /**
     * Real file-backed DB (not `:memory:`) seeded with a plaintext secret,
     * checkpointed to disk to simulate a pre-existing production database
     * (not just something still sitting in the WAL from this same
     * process) -- reproduces exactly what the bug report verified: `grep`
     * the raw .db (and .db-wal) file for the secret after migrating.
     */
    function seedLegacyDbWithPlaintextSecret(): { dbPath: string; walPath: string; db: DatabaseSync } {
      dir = mkdtempSync(join(tmpdir(), 'grunt-migration-003-'));
      const dbPath = join(dir, 'grunt.db');
      const db = openDatabase(dbPath);
      runMigrations(db, [MIGRATIONS[0]!]);
      db.exec(`INSERT INTO mcp_server (id, name, transport, env, header_refs)
               VALUES ('legacy', 'Legacy Srv', 'stdio', '{"GITHUB_TOKEN":"ghp_SuperSecretPlaintextToken1234567890"}', '{}')`);
      db.exec('PRAGMA wal_checkpoint(FULL)');
      return { dbPath, walPath: `${dbPath}-wal`, db };
    }

    function fileContainsSecret(path: string): boolean {
      if (!existsSync(path)) return false;
      return readFileSync(path).includes('ghp_SuperSecretPlaintextToken1234567890');
    }

    it('no longer leaves the dropped plaintext readable in the database file (or its WAL) immediately after migrating', () => {
      const { dbPath, walPath, db } = seedLegacyDbWithPlaintextSecret();
      try {
        expect(fileContainsSecret(dbPath) || fileContainsSecret(walPath)).toBe(true); // sanity: the secret really is on disk before migrating

        runMigrations(db);

        expect(fileContainsSecret(dbPath)).toBe(false);
        expect(fileContainsSecret(walPath)).toBe(false);
      } finally {
        db.close();
      }
    });
  });

  it('creates every table the data model specifies', () => {
    const db = freshDb();
    try {
      runMigrations(db);
      const names = tableNames(db);
      for (const expected of [
        'connection',
        'model',
        'profile',
        'chat',
        'message',
        'attachment',
        'usage',
        'mcp_server',
        'grant',
        'audit',
        'message_fts',
      ]) {
        expect(names).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it('re-running is a no-op: the version stays put and nothing throws', () => {
    const db = freshDb();
    try {
      runMigrations(db);
      const versionBefore = userVersion(db);
      const namesBefore = tableNames(db).sort();
      expect(() => runMigrations(db)).not.toThrow();
      expect(userVersion(db)).toBe(versionBefore);
      expect(tableNames(db).sort()).toEqual(namesBefore);
    } finally {
      db.close();
    }
  });

  it('a failing migration rolls back entirely and leaves user_version unchanged', () => {
    const db = freshDb();
    try {
      const brokenMigrations: Migration[] = [
        {
          version: 1,
          name: '001-broken',
          sql: `
            CREATE TABLE partial_table (id TEXT PRIMARY KEY);
            THIS IS NOT VALID SQL;
          `,
        },
      ];

      expect(() => runMigrations(db, brokenMigrations)).toThrow();
      expect(userVersion(db)).toBe(0);
      expect(tableNames(db)).not.toContain('partial_table');
    } finally {
      db.close();
    }
  });

  it('a throwing postCommit does not abort startup: the migration stays committed, the error is logged by name, and postCommit is not retried on the next run', () => {
    // Regression coverage: postCommit used to run outside any try/catch, so
    // a failure there (disk pressure, or a second process holding the
    // database for migration 003's wal_checkpoint/VACUUM) propagated out of
    // runMigrations and failed createContainer/server startup entirely --
    // even though the migration's own transaction had already committed.
    const db = freshDb();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let postCommitCalls = 0;
    try {
      const withFlakyPostCommit: Migration[] = [
        MIGRATIONS[0]!,
        {
          version: 100,
          name: '100-flaky-post-commit',
          sql: 'CREATE TABLE flaky_marker (id TEXT PRIMARY KEY);',
          postCommit: () => {
            postCommitCalls += 1;
            throw new Error('simulated: disk pressure during VACUUM');
          },
        },
      ];

      expect(() => runMigrations(db, withFlakyPostCommit)).not.toThrow();
      // The migration itself is fully applied -- version advanced, table created --
      // even though its postCommit step blew up.
      expect(userVersion(db)).toBe(100);
      expect(tableNames(db)).toContain('flaky_marker');
      expect(postCommitCalls).toBe(1);

      // Logged clearly enough to identify which migration and that its
      // postCommit was skipped, not swallowed silently.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = String(errorSpy.mock.calls[0]?.[0]);
      expect(logged).toContain('100');
      expect(logged).toContain('100-flaky-post-commit');
      expect(logged).toContain('postCommit');

      // Re-running does NOT retry postCommit: the migration's version is
      // already <= user_version, so the loop skips it entirely.
      runMigrations(db, withFlakyPostCommit);
      expect(postCommitCalls).toBe(1);
    } finally {
      errorSpy.mockRestore();
      db.close();
    }
  });

  it('applies only migrations newer than the current user_version', () => {
    const db = freshDb();
    try {
      runMigrations(db, [MIGRATIONS[0]!]);
      expect(userVersion(db)).toBe(1);

      let secondApplied = false;
      const extended: Migration[] = [
        MIGRATIONS[0]!,
        {
          version: 99,
          name: '099-marker',
          sql: 'CREATE TABLE marker_table (id TEXT PRIMARY KEY);',
        },
      ];
      secondApplied = true;
      runMigrations(db, extended);

      expect(secondApplied).toBe(true);
      expect(userVersion(db)).toBe(99);
      expect(tableNames(db)).toContain('marker_table');
    } finally {
      db.close();
    }
  });

  describe('message_fts', () => {
    it('is queryable and matches inserted search_text via MATCH', () => {
      const db = freshDb();
      try {
        runMigrations(db);
        seedMinimalChain(db);
        db.exec(`
          INSERT INTO message (id, chat_id, parent_id, role, parts, status, search_text, created_at)
          VALUES ('msg-1', 'chat-1', NULL, 'user', '[{"type":"text","text":"the quick brown fox"}]', 'complete', 'the quick brown fox', 1000)
        `);

        const rows = db
          .prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH 'fox'")
          .all() as { rowid: number }[];
        expect(rows.length).toBe(1);
      } finally {
        db.close();
      }
    });

    it('stays in sync on update and delete', () => {
      const db = freshDb();
      try {
        runMigrations(db);
        seedMinimalChain(db);
        db.exec(`
          INSERT INTO message (id, chat_id, parent_id, role, parts, status, search_text, created_at)
          VALUES ('msg-1', 'chat-1', NULL, 'user', '[{"type":"text","text":"alpha"}]', 'complete', 'alpha', 1000)
        `);
        expect(
          (db.prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH 'alpha'").all() as unknown[])
            .length
        ).toBe(1);

        db.exec(`UPDATE message SET search_text = 'beta zephyrwombat' WHERE id = 'msg-1'`);
        expect(
          (db.prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH 'alpha'").all() as unknown[])
            .length
        ).toBe(0);
        expect(
          (
            db
              .prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH 'zephyrwombat'")
              .all() as unknown[]
          ).length
        ).toBe(1);

        db.exec(`DELETE FROM message WHERE id = 'msg-1'`);
        expect(
          (
            db
              .prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH 'zephyrwombat'")
              .all() as unknown[]
          ).length
        ).toBe(0);
      } finally {
        db.close();
      }
    });
  });
});

/** Seeds a minimal connection -> model -> profile -> chat chain so a message row can be inserted. */
function seedMinimalChain(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO connection (id, name, kind, extra_headers, status)
    VALUES ('conn-1', 'Test Connection', 'mock', '{}', 'unknown');
    INSERT INTO model (id, connection_id, model_id, display_name, source, currency)
    VALUES ('model-1', 'conn-1', 'test-model', 'Test Model', 'manual', 'USD');
    INSERT INTO profile (id, name, connection_id, model_id, params, tool_policy, is_default)
    VALUES ('profile-1', 'Test Profile', 'conn-1', 'model-1', '{}', '{}', 0);
    INSERT INTO chat (id, title, profile_id, pinned, created_at, updated_at)
    VALUES ('chat-1', 'Test Chat', 'profile-1', 0, 1000, 1000);
  `);
}
