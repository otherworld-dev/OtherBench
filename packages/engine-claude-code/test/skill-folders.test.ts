import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeSkillFolders } from '../src/skill-folders.js';
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
