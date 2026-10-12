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
  it('mcp-oauth adds mcp_server.oauth, empty for every existing server', () => {
    const mcpOauth = MIGRATIONS.find((m) => m.name.endsWith('mcp-oauth'));
    expect(mcpOauth).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < mcpOauth!.version));
      db.exec(`INSERT INTO mcp_server (id, name, transport) VALUES ('s1', 'Old', 'http')`);
      runMigrations(db);
      expect(db.prepare(`SELECT oauth FROM mcp_server WHERE id = 's1'`).get()).toEqual({ oauth: null });
    } finally {
      db.close();
    }
  });

  it('016 adds the artifact tables, tracked for sync', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['artifact', 'artifact_version']));
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_artifact%'").all() as { name: string }[]).map((t) => t.name);
    expect(triggers.sort()).toEqual(['sync_artifact_ad', 'sync_artifact_ai', 'sync_artifact_au', 'sync_artifact_version_ad', 'sync_artifact_version_ai', 'sync_artifact_version_au']);
  });

  it("017 gives each artifact version its own kind and language, filled from its artifact, without logging a sync change", () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS.filter((m) => m.version <= 16));
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare("INSERT INTO artifact (id, chat_id, slug, kind, language, created_at) VALUES ('a1', 'c1', 'lib', 'code', 'py', 1)").run();
    db.prepare("INSERT INTO artifact_version (id, artifact_id, number, title, content, made_by, message_id, parent_version_id, created_at) VALUES ('v1', 'a1', 1, 'Lib', 'x', 'model', NULL, NULL, 2)").run();
    const logged = (): number => (db.prepare("SELECT COUNT(*) AS n FROM change_log WHERE tbl = 'artifact_version'").get() as { n: number }).n;
    const before = logged();
    runMigrations(db);
    expect(db.prepare("SELECT kind, language FROM artifact_version WHERE id = 'v1'").get()).toEqual({ kind: 'code', language: 'py' });
    expect(logged()).toBe(before);
  });

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

  it('chat-auto-mode adds chat.auto_mode, with every existing chat off', () => {
    const autoMode = MIGRATIONS.find((m) => m.name.endsWith('chat-auto-mode'));
    expect(autoMode).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < autoMode!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'CC', 'claude_code')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'Sonnet', 'c1', 'sonnet')`);
      db.exec(`INSERT INTO chat (id, title, profile_id, created_at, updated_at) VALUES ('legacy', 'Old chat', 'p1', 1, 1)`);
      runMigrations(db);
      const row = db.prepare(`SELECT auto_mode FROM chat WHERE id = 'legacy'`).get() as { auto_mode: number };
      expect(row.auto_mode).toBe(0);
      expect(userVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    } finally {
      db.close();
    }
  });

  it("chat-effort adds chat.effort, every existing chat following Claude Code's own settings", () => {
    const effort = MIGRATIONS.find((m) => m.name.endsWith('chat-effort'));
    expect(effort).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < effort!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'CC', 'claude_code')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'Opus', 'c1', 'opus')`);
      db.exec(`INSERT INTO chat (id, title, profile_id, created_at, updated_at) VALUES ('legacy', 'Old chat', 'p1', 1, 1)`);
      runMigrations(db);
      expect(db.prepare(`SELECT effort FROM chat WHERE id = 'legacy'`).get()).toEqual({ effort: null });
    } finally {
      db.close();
    }
  });

  it('chat-plan-mode adds chat.plan_mode, with every existing chat off', () => {
    const migration = MIGRATIONS.find((m) => m.name.endsWith('chat-plan-mode'));
    expect(migration).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < migration!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'Mock', 'mock')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'Mock', 'c1', 'mock')`);
      db.exec(`INSERT INTO chat (id, title, profile_id, created_at, updated_at) VALUES ('legacy', 'Old chat', 'p1', 1, 1)`);
      runMigrations(db);
      expect(db.prepare(`SELECT plan_mode FROM chat WHERE id = 'legacy'`).get()).toEqual({ plan_mode: 0 });
    } finally {
      db.close();
    }
  });

  it('extra-folders gives every existing chat and project an empty folder list', () => {
    const folders = MIGRATIONS.find((m) => m.name.endsWith('extra-folders'));
    expect(folders).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < folders!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'CC', 'claude_code')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'Opus', 'c1', 'opus')`);
      db.exec(`INSERT INTO chat (id, title, profile_id, created_at, updated_at) VALUES ('legacy', 'Old chat', 'p1', 1, 1)`);
      db.exec(`INSERT INTO project (id, name, created_at, updated_at) VALUES ('proj', 'Old project', 1, 1)`);
      runMigrations(db);
      expect(db.prepare(`SELECT folders FROM chat WHERE id = 'legacy'`).get()).toEqual({ folders: '[]' });
      expect(db.prepare(`SELECT folders FROM project WHERE id = 'proj'`).get()).toEqual({ folders: '[]' });
    } finally {
      db.close();
    }
  });

  it('project-details gives every existing project an empty description and instructions', () => {
    const details = MIGRATIONS.find((m) => m.name.endsWith('project-details'));
    expect(details).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < details!.version));
      db.exec(`INSERT INTO project (id, name, created_at, updated_at) VALUES ('proj', 'Old project', 1, 1)`);
      runMigrations(db);
      expect(db.prepare(`SELECT description, instructions FROM project WHERE id = 'proj'`).get()).toEqual({ description: '', instructions: '' });
    } finally {
      db.close();
    }
  });

  it('chat-sort-order gives every existing chat its last activity as its place, keeping the old activity order', () => {
    const sortOrder = MIGRATIONS.find((m) => m.name.endsWith('chat-sort-order'));
    expect(sortOrder).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < sortOrder!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'Mock', 'mock')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'P', 'c1', 'm')`);
      db.exec(`INSERT INTO chat (id, title, profile_id, created_at, updated_at) VALUES ('older', 'A', 'p1', 1, 500), ('newer', 'B', 'p1', 2, 900)`);
      runMigrations(db);
      const rows = db.prepare(`SELECT id, sort_order FROM chat ORDER BY sort_order DESC`).all() as { id: string; sort_order: number }[];
      expect(rows).toEqual([
        { id: 'newer', sort_order: 900 },
        { id: 'older', sort_order: 500 },
      ]);
    } finally {
      db.close();
    }
  });

  it('projects adds the project table and chat.project_id: existing chats are in no project, and both foreign keys set NULL on delete', () => {
    const projects = MIGRATIONS.find((m) => m.name.endsWith('-projects'));
    expect(projects).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < projects!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'Mock', 'mock')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'Default', 'c1', 'm')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p2', 'Spare', 'c1', 'm')`);
      db.exec(`INSERT INTO chat (id, title, profile_id, created_at, updated_at) VALUES ('legacy', 'Old chat', 'p1', 1, 1)`);

      runMigrations(db);

      const projectIdOf = () => (db.prepare(`SELECT project_id FROM chat WHERE id = 'legacy'`).get() as { project_id: string | null }).project_id;
      expect(projectIdOf()).toBeNull();
      expect(userVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));

      db.exec(`INSERT INTO project (id, name, default_profile_id, created_at, updated_at) VALUES ('proj', 'Alpha', 'p2', 1, 1)`);
      db.exec(`UPDATE chat SET project_id = 'proj' WHERE id = 'legacy'`);
      expect(projectIdOf()).toBe('proj');

      db.exec(`DELETE FROM profile WHERE id = 'p2'`);
      const project = db.prepare(`SELECT default_profile_id FROM project WHERE id = 'proj'`).get() as { default_profile_id: string | null };
      expect(project.default_profile_id).toBeNull();

      db.exec(`DELETE FROM project WHERE id = 'proj'`);
      expect(projectIdOf()).toBeNull();
      expect(db.prepare(`SELECT id FROM chat`).all()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('global-memory adds its tables, starts each chat at its newest message (no backfill) and leaves every profile on', () => {
    const migration = MIGRATIONS.find((m) => m.name.endsWith('-global-memory'));
    expect(migration).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < migration!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'Mock', 'mock')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'Default', 'c1', 'm')`);
      db.exec(`INSERT INTO chat (id, title, profile_id, created_at, updated_at) VALUES ('busy', 'Busy', 'p1', 1, 1)`);
      db.exec(`INSERT INTO chat (id, title, profile_id, created_at, updated_at) VALUES ('empty', 'Empty', 'p1', 1, 1)`);
      const insert = (id: string, parent: string | null, role: string, at: number): void =>
        db.exec(`INSERT INTO message (id, chat_id, parent_id, role, parts, status, created_at) VALUES ('${id}', 'busy', ${parent ? `'${parent}'` : 'NULL'}, '${role}', '[]', 'complete', ${at})`);
      insert('m1', null, 'user', 10);
      insert('m2', 'm1', 'assistant', 11);

      runMigrations(db);

      expect(tableNames(db)).toEqual(expect.arrayContaining(['global_memory', 'global_memory_version']));
      const cursor = (id: string): string | null =>
        (db.prepare(`SELECT global_memory_cursor FROM chat WHERE id = ?`).get(id) as { global_memory_cursor: string | null }).global_memory_cursor;
      expect(cursor('busy')).toBe('m2');
      expect(cursor('empty')).toBeNull();
      expect(db.prepare(`SELECT use_global_memory FROM profile WHERE id = 'p1'`).get()).toEqual({ use_global_memory: 1 });
      expect(() => db.exec(`INSERT INTO global_memory (key, body, updated_at, updated_by) VALUES ('other', 'x', 1, 'user')`)).toThrow();
    } finally {
      db.close();
    }
  });

  it('project-memory seeds each existing chat cursor to its newest message (no backfill on upgrade)', () => {
    const migration = MIGRATIONS.find((m) => m.name.endsWith('-project-memory'));
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < migration!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'Mock', 'mock')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'Default', 'c1', 'm')`);
      db.exec(`INSERT INTO project (id, name, created_at, updated_at) VALUES ('proj', 'Alpha', 1, 1)`);
      db.exec(`INSERT INTO chat (id, title, profile_id, project_id, created_at, updated_at) VALUES ('busy', 'Busy', 'p1', 'proj', 1, 1)`);
      db.exec(`INSERT INTO chat (id, title, profile_id, project_id, created_at, updated_at) VALUES ('empty', 'Empty', 'p1', 'proj', 1, 1)`);
      const insert = (id: string, parent: string | null, role: string, at: number): void =>
        db.exec(`INSERT INTO message (id, chat_id, parent_id, role, parts, status, created_at) VALUES ('${id}', 'busy', ${parent ? `'${parent}'` : 'NULL'}, '${role}', '[]', 'complete', ${at})`);
      insert('m1', null, 'user', 10);
      insert('m2', 'm1', 'assistant', 11);
      insert('m3', 'm2', 'user', 20);
      insert('m4', 'm3', 'assistant', 20); // same timestamp as m3: the later id wins

      runMigrations(db);

      const cursor = (id: string): string | null => (db.prepare(`SELECT memory_cursor FROM chat WHERE id = ?`).get(id) as { memory_cursor: string | null }).memory_cursor;
      expect(cursor('busy')).toBe('m4');
      expect(cursor('empty')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('project-memory adds the note and version tables, the chat memory columns and app settings; notes cascade with their project', () => {
    const migration = MIGRATIONS.find((m) => m.name.endsWith('-project-memory'));
    expect(migration).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < migration!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'Mock', 'mock')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'Default', 'c1', 'm')`);
      db.exec(`INSERT INTO project (id, name, created_at, updated_at) VALUES ('proj', 'Alpha', 1, 1)`);
      db.exec(`INSERT INTO chat (id, title, profile_id, project_id, created_at, updated_at) VALUES ('legacy', 'Old chat', 'p1', 'proj', 1, 1)`);

      runMigrations(db);

      expect(userVersion(db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
      const chat = db.prepare(`SELECT memory_cursor, memory_excluded FROM chat WHERE id = 'legacy'`).get() as { memory_cursor: string | null; memory_excluded: number };
      expect(chat.memory_cursor).toBeNull();
      expect(chat.memory_excluded).toBe(0);

      db.exec(`INSERT INTO project_memory (project_id, body, updated_at, updated_by) VALUES ('proj', 'note', 1, 'user')`);
      db.exec(`INSERT INTO project_memory_version (id, project_id, body, created_at, created_by) VALUES ('v1', 'proj', 'note', 1, 'user')`);
      expect(() => db.exec(`UPDATE project_memory SET updated_by = 'robot'`)).toThrow();
      db.exec(`INSERT INTO app_setting (key, value) VALUES ('memoryProfileId', '"p1"')`);

      db.exec(`DELETE FROM project WHERE id = 'proj'`);
      const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('project_memory')).toBe(0);
      expect(count('project_memory_version')).toBe(0);
      expect(count('app_setting')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('nodes-and-locations creates this machine once and binds every existing folder, chat and message to it', () => {
    const migration = MIGRATIONS.find((m) => m.name.endsWith('-nodes-and-locations'));
    expect(migration).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < migration!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'Mock', 'mock')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'Default', 'c1', 'm')`);
      db.exec(`INSERT INTO project (id, name, workspace_root, created_at, updated_at) VALUES ('proj-ws', 'A', '/git', 1, 1), ('proj-none', 'B', NULL, 1, 1)`);
      db.exec(`INSERT INTO chat (id, title, profile_id, workspace_root, created_at, updated_at) VALUES ('ws', 'A', 'p1', '/git/grunt', 1, 1), ('none', 'B', 'p1', NULL, 1, 1)`);
      db.exec(`INSERT INTO message (id, chat_id, parent_id, role, parts, status, created_at) VALUES ('m1', 'ws', NULL, 'user', '[]', 'complete', 1)`);

      runMigrations(db);

      const nodes = db.prepare(`SELECT id, name FROM node_self`).all() as { id: string; name: string }[];
      expect(nodes).toHaveLength(1);
      const self = nodes[0]!.id;
      expect(nodes[0]!.name.length).toBeGreaterThan(0);
      const chats = db.prepare(`SELECT id, workspace_root, workspace_node, workspace_location_id, runs_on FROM chat ORDER BY id`).all();
      expect(chats).toEqual([
        { id: 'none', workspace_root: null, workspace_node: null, workspace_location_id: null, runs_on: self },
        { id: 'ws', workspace_root: '/git/grunt', workspace_node: self, workspace_location_id: null, runs_on: self },
      ]);
      expect(db.prepare(`SELECT id, workspace_node FROM project ORDER BY id`).all()).toEqual([
        { id: 'proj-none', workspace_node: null },
        { id: 'proj-ws', workspace_node: self },
      ]);
      expect(db.prepare(`SELECT origin_node FROM message`).all()).toEqual([{ origin_node: self }]);

      runMigrations(db);
      expect(db.prepare(`SELECT id FROM node_self`).all()).toEqual([{ id: self }]);

      // A location's paths go with it; a chat using it keeps existing, without a folder.
      db.exec(`INSERT INTO location (id, name) VALUES ('nc', 'Nextcloud')`);
      db.exec(`INSERT INTO location_path (location_id, node_id, path) VALUES ('nc', '${self}', '/nextcloud')`);
      expect(() => db.exec(`INSERT INTO location_path (location_id, node_id, path) VALUES ('nc', '${self}', '/x')`)).toThrow();
      db.exec(`UPDATE chat SET workspace_location_id = 'nc', workspace_subpath = 'phd' WHERE id = 'none'`);
      db.exec(`DELETE FROM location WHERE id = 'nc'`);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM location_path`).get()).toEqual({ n: 0 });
      expect(db.prepare(`SELECT workspace_location_id FROM chat WHERE id = 'none'`).get()).toEqual({ workspace_location_id: null });
    } finally {
      db.close();
    }
  });

  it('peers adds the peer table, and binds every earlier audit decision to this machine', () => {
    const migration = MIGRATIONS.find((m) => m.name.endsWith('-peers'));
    expect(migration).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < migration!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'Mock', 'mock')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'Default', 'c1', 'm')`);
      db.exec(`INSERT INTO chat (id, title, profile_id, created_at, updated_at) VALUES ('c', 'A', 'p1', 1, 1)`);
      db.exec(`INSERT INTO message (id, chat_id, parent_id, role, parts, status, created_at) VALUES ('m', 'c', NULL, 'user', '[]', 'complete', 1)`);
      db.exec(`INSERT INTO audit (id, chat_id, message_id, tool_name, args_redacted, result_summary, duration_ms, granted_by, created_at) VALUES ('a', 'c', 'm', 't', '{}', 'ok', 1, 'user', 1)`);

      runMigrations(db);

      const self = (db.prepare(`SELECT id FROM node_self`).get() as { id: string }).id;
      expect(db.prepare(`SELECT decided_on_node FROM audit`).all()).toEqual([{ decided_on_node: self }]);
      db.exec(`INSERT INTO peer (node_id, name, fingerprint, issued_token_hash, held_token_ref, paired_at) VALUES ('pc', 'PC', 'fp', 'h', 'r', 1)`);
      expect(() => db.exec(`INSERT INTO peer (node_id, name, fingerprint, issued_token_hash, held_token_ref, paired_at) VALUES ('other', 'X', 'fp', 'h', 'r', 1)`)).toThrow();
      expect(db.prepare(`SELECT addresses, last_sync_seq FROM peer`).get()).toEqual({ addresses: '[]', last_sync_seq: 0 });
    } finally {
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
        'project',
        'project_memory',
        'project_memory_version',
        'app_setting',
        'message_fts',
        'node_self',
        'location',
        'location_path',
        'peer',
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

  it('schedules adds the local schedule tables: no sync triggers, one target, and cascades from chat, project and profile', () => {
    const migration = MIGRATIONS.find((m) => m.name.endsWith('-schedules'));
    expect(migration).toBeDefined();
    const db = freshDb();
    try {
      runMigrations(db, MIGRATIONS.filter((m) => m.version < migration!.version));
      db.exec(`INSERT INTO connection (id, name, kind) VALUES ('c1', 'Mock', 'mock')`);
      db.exec(`INSERT INTO profile (id, name, connection_id, model_id) VALUES ('p1', 'Default', 'c1', 'm')`);
      db.exec(`INSERT INTO chat (id, title, profile_id, created_at, updated_at) VALUES ('chat1', 'Chat', 'p1', 1, 1)`);
      db.exec(`INSERT INTO project (id, name, sort_order, created_at, updated_at) VALUES ('proj1', 'Alpha', 0, 1, 1)`);

      runMigrations(db);

      expect(tableNames(db)).toEqual(expect.arrayContaining(['schedule', 'schedule_run']));
      const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_schedule%'").all();
      expect(triggers).toEqual([]);
      const insert = (id: string, chat: string | null, project: string | null): void =>
        db.exec(
          `INSERT INTO schedule (id, name, prompt, profile_id, chat_id, project_id, rule, timezone, enabled, next_run_at, created_at, updated_at)
           VALUES ('${id}', 'S', 'p', 'p1', ${chat ? `'${chat}'` : 'NULL'}, ${project ? `'${project}'` : 'NULL'}, '{"cadence":"daily","time":"09:00"}', 'UTC', 1, 5, 1, 1)`
        );
      expect(() => insert('both', 'chat1', 'proj1')).toThrow();
      expect(() => insert('neither', null, null)).toThrow();
      insert('on-chat', 'chat1', null);
      insert('on-project', null, 'proj1');
      db.exec(`INSERT INTO schedule_run (id, schedule_id, trigger, started_at, status, chat_id) VALUES ('r1', 'on-project', 'scheduled', 1, 'running', 'chat1')`);
      expect(() => db.exec(`INSERT INTO schedule_run (id, schedule_id, trigger, started_at, status) VALUES ('r2', 'on-chat', 'hourly', 1, 'running')`)).toThrow();

      db.exec(`DELETE FROM chat WHERE id = 'chat1'`);
      expect(db.prepare(`SELECT id FROM schedule ORDER BY id`).all()).toEqual([{ id: 'on-project' }]);
      expect(db.prepare(`SELECT chat_id FROM schedule_run WHERE id = 'r1'`).get()).toEqual({ chat_id: null });
      db.exec(`DELETE FROM project WHERE id = 'proj1'`);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM schedule`).get()).toEqual({ n: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM schedule_run`).get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
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
