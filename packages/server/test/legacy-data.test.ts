import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { adoptLegacyData, claudeProjectKey, LegacyDataError, rewriteLegacyPaths } from '../src/legacy-data.js';

let home: string;
const dead = (): boolean => false;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'otherbench-legacy-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** The imported project's folder, as Grunt stored it. */
function importedFolder(dataDir: string, db: string): string {
  return join(dataDir, `${db}.imported`, 'claude', 'Personal-1');
}

/** The one project's stored folders, read back from the database at `path`. */
function storedFolders(path: string): unknown {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.parse((db.prepare('SELECT folders FROM project').get() as { folders: string }).folders);
  } finally {
    db.close();
  }
}

/** Grunt's folder as it last left it, with a database holding one imported project. */
function gruntData(): string {
  const dir = join(home, '.grunt');
  mkdirSync(join(dir, 'grunt.db.attachments', 'ab'), { recursive: true });
  mkdirSync(join(dir, 'grunt.db.imported'));
  mkdirSync(join(dir, 'claude-scratch', 'chat-1'), { recursive: true });
  const db = new DatabaseSync(join(dir, 'grunt.db'));
  db.exec('CREATE TABLE project (id TEXT, folders TEXT)');
  db.prepare('INSERT INTO project VALUES (?, ?)').run('p1', JSON.stringify([{ root: importedFolder(dir, 'grunt.db') }]));
  db.close();
  writeFileSync(join(dir, 'grunt.db.lock'), JSON.stringify({ pid: 4242, startedAt: 1 }));
  writeFileSync(join(dir, 'grunt.db.attachments', 'ab', 'abcd'), 'blob');
  writeFileSync(join(dir, 'secrets.json'), '{}');
  writeFileSync(join(dir, 'secrets.json.key'), 'key');
  return dir;
}

describe('adoptLegacyData', () => {
  it('moves the folder and renames the database and everything named after it', () => {
    gruntData();

    const moved = adoptLegacyData(home, { isAlive: dead });

    const dir = join(home, '.otherbench');
    expect(moved).toContain(dir);
    expect(existsSync(join(home, '.grunt'))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(
      [
        'claude-scratch',
        'otherbench.db',
        'otherbench.db.attachments',
        'otherbench.db.imported',
        'otherbench.db.lock',
        'secrets.json',
        'secrets.json.key',
      ].sort()
    );
    expect(storedFolders(join(dir, 'otherbench.db'))).toEqual([{ root: importedFolder(dir, 'otherbench.db') }]);
    expect(readFileSync(join(dir, 'otherbench.db.attachments', 'ab', 'abcd'), 'utf8')).toBe('blob');
    expect(readFileSync(join(dir, 'secrets.json.key'), 'utf8')).toBe('key');
  });

  it('does nothing when there is no Grunt folder', () => {
    expect(adoptLegacyData(home, { isAlive: dead })).toBeNull();
    expect(existsSync(join(home, '.otherbench'))).toBe(false);
  });

  it('never touches either folder once ~/.otherbench exists', () => {
    gruntData();
    mkdirSync(join(home, '.otherbench'));

    expect(adoptLegacyData(home, { isAlive: dead })).toBeNull();
    expect(existsSync(join(home, '.grunt', 'grunt.db'))).toBe(true);
    expect(readdirSync(join(home, '.otherbench'))).toEqual([]);
  });

  it('refuses while Grunt is still running, and moves nothing', () => {
    gruntData();

    expect(() => adoptLegacyData(home, { isAlive: (pid) => pid === 4242 })).toThrow(LegacyDataError);
    expect(() => adoptLegacyData(home, { isAlive: (pid) => pid === 4242 })).toThrow(/pid 4242/);
    expect(existsSync(join(home, '.grunt', 'grunt.db'))).toBe(true);
    expect(existsSync(join(home, '.otherbench'))).toBe(false);
  });

  it('finishes a move that stopped after renaming some of the files', () => {
    const dir = gruntData();
    // An earlier start renamed the database itself, then failed.
    renameSync(join(dir, 'grunt.db'), join(dir, 'otherbench.db'));

    adoptLegacyData(home, { isAlive: dead });

    const newDir = join(home, '.otherbench');
    expect(storedFolders(join(newDir, 'otherbench.db'))).toEqual([{ root: importedFolder(newDir, 'otherbench.db') }]);
    expect(existsSync(join(newDir, 'otherbench.db.lock'))).toBe(true);
  });

  it("renames Claude Code's projects for the scratch folders, so those sessions resume", () => {
    gruntData();
    const claude = join(home, '.claude');
    const projects = join(claude, 'projects');
    const oldProject = `${claudeProjectKey(join(home, '.grunt', 'claude-scratch'))}-chat-1`;
    const other = claudeProjectKey(join(home, 'code', 'app'));
    mkdirSync(join(projects, oldProject), { recursive: true });
    mkdirSync(join(projects, other));
    writeFileSync(join(projects, oldProject, 'session.jsonl'), '{}');

    adoptLegacyData(home, { isAlive: dead, claudeConfigDir: claude });

    const newProject = `${claudeProjectKey(join(home, '.otherbench', 'claude-scratch'))}-chat-1`;
    expect(readdirSync(projects).sort()).toEqual([newProject, other].sort());
    expect(readFileSync(join(projects, newProject, 'session.jsonl'), 'utf8')).toBe('{}');
  });

  it("still moves the data when Claude Code has no projects folder", () => {
    gruntData();

    expect(adoptLegacyData(home, { isAlive: dead, claudeConfigDir: join(home, 'nowhere') })).not.toBeNull();
    expect(existsSync(join(home, '.otherbench', 'otherbench.db'))).toBe(true);
  });
});

describe('rewriteLegacyPaths', () => {
  it('points stored paths at the new folder, plain or inside JSON, and leaves message text alone', () => {
    const oldDir = join(home, '.grunt');
    const newDir = join(home, '.otherbench');
    const dbPath = join(home, 'test.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE project (id TEXT, workspace_root TEXT, folders TEXT);
      CREATE TABLE message (id TEXT, parts TEXT, engine_meta TEXT);
      CREATE TABLE attachment (id TEXT, storage_path TEXT);
    `);
    const imported = join(oldDir, 'grunt.db.imported', 'claude', 'Personal-1');
    const scratch = join(oldDir, 'claude-scratch', 'chat-1');
    const blob = join(oldDir, 'grunt.db.attachments', 'ab', 'abcd');
    const elsewhere = join(home, 'code', 'app');
    db.prepare('INSERT INTO project VALUES (?, ?, ?)').run('p1', elsewhere, JSON.stringify([{ workspace: { root: imported } }]));
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('m1', JSON.stringify([{ text: `read ${blob}` }]), JSON.stringify({ cwd: scratch }));
    db.prepare('INSERT INTO attachment VALUES (?, ?)').run('a1', blob);
    db.close();

    // chat and location_path don't exist in this database: skipped, not an error.
    expect(rewriteLegacyPaths(dbPath, oldDir, newDir)).toBe(3);

    const after = new DatabaseSync(dbPath, { readOnly: true });
    const project = after.prepare('SELECT workspace_root, folders FROM project').get() as { workspace_root: string; folders: string };
    const message = after.prepare('SELECT parts, engine_meta FROM message').get() as { parts: string; engine_meta: string };
    const attachment = after.prepare('SELECT storage_path FROM attachment').get() as { storage_path: string };
    after.close();
    expect(project.workspace_root).toBe(elsewhere);
    expect(JSON.parse(project.folders)).toEqual([{ workspace: { root: join(newDir, 'otherbench.db.imported', 'claude', 'Personal-1') } }]);
    expect(JSON.parse(message.engine_meta)).toEqual({ cwd: join(newDir, 'claude-scratch', 'chat-1') });
    expect(JSON.parse(message.parts)).toEqual([{ text: `read ${blob}` }]);
    expect(attachment.storage_path).toBe(join(newDir, 'otherbench.db.attachments', 'ab', 'abcd'));
  });

  it('is run by the move, which still succeeds when the database cannot be opened', () => {
    writeFileSync(join(gruntData(), 'grunt.db'), 'not a database');

    const moved = adoptLegacyData(home, { isAlive: dead });

    expect(moved).toContain("Couldn't update the folder paths");
    expect(existsSync(join(home, '.otherbench', 'otherbench.db'))).toBe(true);
  });
});

describe('claudeProjectKey', () => {
  it("matches Claude Code's folder name for a Windows path", () => {
    expect(claudeProjectKey('C:\\Users\\Adam\\.grunt\\claude-scratch\\3c78b9be-186f')).toBe('C--Users-Adam--grunt-claude-scratch-3c78b9be-186f');
  });
});
