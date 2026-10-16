import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptLegacyData, claudeProjectKey, LegacyDataError } from '../src/legacy-data.js';

let home: string;
const dead = (): boolean => false;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'otherbench-legacy-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Grunt's folder as it last left it. */
function gruntData(): string {
  const dir = join(home, '.grunt');
  mkdirSync(join(dir, 'grunt.db.attachments', 'ab'), { recursive: true });
  mkdirSync(join(dir, 'grunt.db.imported'));
  mkdirSync(join(dir, 'claude-scratch', 'chat-1'), { recursive: true });
  writeFileSync(join(dir, 'grunt.db'), 'db');
  writeFileSync(join(dir, 'grunt.db-wal'), 'wal');
  writeFileSync(join(dir, 'grunt.db-shm'), 'shm');
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
        'otherbench.db-shm',
        'otherbench.db-wal',
        'otherbench.db.attachments',
        'otherbench.db.imported',
        'otherbench.db.lock',
        'secrets.json',
        'secrets.json.key',
      ].sort()
    );
    expect(readFileSync(join(dir, 'otherbench.db'), 'utf8')).toBe('db');
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
    rmSync(join(dir, 'grunt.db'));
    writeFileSync(join(dir, 'otherbench.db'), 'db');

    adoptLegacyData(home, { isAlive: dead });

    expect(readFileSync(join(home, '.otherbench', 'otherbench.db'), 'utf8')).toBe('db');
    expect(existsSync(join(home, '.otherbench', 'otherbench.db-wal'))).toBe(true);
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

describe('claudeProjectKey', () => {
  it("matches Claude Code's folder name for a Windows path", () => {
    expect(claudeProjectKey('C:\\Users\\Adam\\.grunt\\claude-scratch\\3c78b9be-186f')).toBe('C--Users-Adam--grunt-claude-scratch-3c78b9be-186f');
  });
});
