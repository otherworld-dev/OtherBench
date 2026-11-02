import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectFolders, claudeProjectName, claudeSkillFolders } from '../src/skill-folders.js';
import { normaliseAgentArgs } from '../src/approval.js';

let home: string;
let ws: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'otherbench-home-'));
  ws = mkdtempSync(join(tmpdir(), 'otherbench-ws-'));
  mkdirSync(join(home, '.claude', 'skills', 'claude-setup'), { recursive: true });
  mkdirSync(join(home, '.claude', 'plugins', 'cache'), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

describe('claudeSkillFolders', () => {
  it('gives the skills and plugin cache folders, read-only', () => {
    expect(claudeSkillFolders({}, ws, home)).toEqual([
      { root: join(home, '.claude', 'skills'), access: 'read' },
      { root: join(home, '.claude', 'plugins', 'cache'), access: 'read' },
    ]);
  });
  it('follows CLAUDE_CONFIG_DIR', () => {
    const config = join(home, 'cfg');
    mkdirSync(join(config, 'skills'), { recursive: true });
    expect(claudeSkillFolders({ CLAUDE_CONFIG_DIR: config }, ws, home)).toEqual([{ root: join(config, 'skills'), access: 'read' }]);
  });
  it('ignores a relative CLAUDE_CONFIG_DIR', () => {
    expect(claudeSkillFolders({ CLAUDE_CONFIG_DIR: 'cfg' }, ws, home).map((f) => f.root)).toEqual([join(home, '.claude', 'skills'), join(home, '.claude', 'plugins', 'cache')]);
  });
  it('leaves out folders that are missing or inside the workspace', () => {
    expect(claudeSkillFolders({}, ws, join(home, 'nobody'))).toEqual([]);
    expect(claudeSkillFolders({}, home, home)).toEqual([]);
  });
  it("lets a skill read its own files but never the config folder's login, nor write a skill", () => {
    const folders = claudeSkillFolders({}, ws, home);
    const standard = join(home, '.claude', 'skills', 'claude-setup', 'standard.md');
    expect(normaliseAgentArgs('Read', { file_path: standard }, ws, folders)).toHaveProperty('args');
    expect(normaliseAgentArgs('Read', { file_path: join(home, '.claude', '.credentials.json') }, ws, folders)).toHaveProperty('outside');
    expect(normaliseAgentArgs('Write', { file_path: standard, content: 'x' }, ws, folders)).toHaveProperty('readOnly');
  });
});

describe('claudeProjectName', () => {
  it("makes every character but a letter or digit '-', as Claude Code does", () => {
    expect(claudeProjectName(ws)).toBe(realpathSync(ws).replace(/[^a-zA-Z0-9]/g, '-'));
  });
  it.runIf(process.platform === 'win32')('names a Windows folder as Claude Code does', () => {
    expect(claudeProjectName('E:\\Git\\Nextcloud Git2Deck\\not-there')).toBe('E--Git-Nextcloud-Git2Deck-not-there');
  });
  it('cuts a name past 200 characters and adds a hash of the whole path', () => {
    const deep = join(ws, 'a'.repeat(120), 'b'.repeat(120));
    const name = claudeProjectName(deep);
    expect(name).toMatch(/^.{200}-[0-9a-z]+$/);
    expect(name.slice(0, 200)).toBe(resolve(deep).replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200));
    expect(claudeProjectName(join(ws, 'a'.repeat(120), 'c'.repeat(120)))).not.toBe(name);
  });
});

describe('claudeProjectFolders', () => {
  const project = (): string => join(home, '.claude', 'projects', claudeProjectName(ws));
  it("gives the workspace's project folder read-only and its memory writable, made yet or not", () => {
    expect(claudeProjectFolders({}, ws, home)).toEqual([
      { root: project(), access: 'read' },
      { root: join(project(), 'memory'), access: 'readwrite' },
    ]);
  });
  it('follows CLAUDE_CONFIG_DIR', () => {
    const config = join(home, 'cfg');
    expect(claudeProjectFolders({ CLAUDE_CONFIG_DIR: config }, ws, home)[0]?.root).toBe(join(config, 'projects', claudeProjectName(ws)));
  });
  it('is left out when it is inside the workspace', () => {
    expect(claudeProjectFolders({}, home, home)).toEqual([]);
  });
  it('lets Claude Code read its transcripts and write its memory, but never write a transcript', () => {
    mkdirSync(join(project(), 'memory'), { recursive: true });
    const folders = claudeProjectFolders({}, ws, home);
    const note = join(project(), 'memory', 'MEMORY.md');
    const transcript = join(project(), 'abc.jsonl');
    expect(normaliseAgentArgs('Write', { file_path: note, content: 'x' }, ws, folders)).toHaveProperty('args');
    expect(normaliseAgentArgs('Read', { file_path: transcript }, ws, folders)).toHaveProperty('args');
    expect(normaliseAgentArgs('Write', { file_path: transcript, content: 'x' }, ws, folders)).toHaveProperty('readOnly');
    expect(normaliseAgentArgs('Write', { file_path: join(home, '.claude', 'projects', 'other', 'memory', 'x.md'), content: 'x' }, ws, folders)).toHaveProperty('outside');
  });
});
