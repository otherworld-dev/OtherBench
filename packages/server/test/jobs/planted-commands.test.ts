import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { plantedCommandIn } from '@otherbench/core/domain/job.js';
import { JobGit } from '../../src/jobs/git.js';

/**
 * A later guarantee for job folders (docs/features/jobs.md): a job's
 * sandboxed command can plant a program in its folder's top level that
 * Windows would run for a bare `git` from there. Observed live with real
 * Claude Code (engine-claude-code/scripts/probe-planted-*.mjs): Claude Code
 * runs git by absolute path and ran none of 228 stand-ins, mid-turn or at
 * start; Node's spawn never looks in the working folder; cmd.exe does, unless
 * NoDefaultCurrentDirectoryInExePath is set. This keeps that observation in
 * the suite with script stand-ins (an .exe can't be built here).
 */
const windows = process.platform === 'win32';
let tmp: string;
let folder: string;
let markers: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'otherbench-planted-'));
  folder = join(tmp, 'job');
  markers = join(tmp, 'markers');
  mkdirSync(markers);
  execFileSync('git', ['init', '-q', '-b', 'test/x', folder]);
  writeFileSync(join(folder, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.']);
  execFileSync('git', ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base']);
  for (const ext of ['cmd', 'bat']) {
    writeFileSync(join(folder, `git.${ext}`), `@echo %* > "${join(markers, `git.${ext}.txt`)}"\r\n@exit /b 1\r\n`);
  }
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const envWithout = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^NoDefaultCurrentDirectoryInExePath$/i.test(k)) delete env[k];
  return env;
};

describe.runIf(windows)('a stand-in for git planted in a job folder', () => {
  it("is never run by Node's own spawn from that folder, with or without the variable", () => {
    for (const env of [envWithout(), { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' }]) {
      const r = spawnSync('git', ['--version'], { cwd: folder, env, encoding: 'utf8' });
      expect(r.stdout).toMatch(/^git version/);
    }
    expect(readdirSync(markers)).toEqual([]);
  });

  it('is run by cmd.exe from that folder without the variable, and not with it (the control)', () => {
    spawnSync('cmd.exe', ['/d', '/c', 'git --version'], { cwd: folder, env: envWithout(), encoding: 'utf8' });
    expect(readdirSync(markers).length).toBeGreaterThan(0);
    const before = readdirSync(markers).length;
    const r = spawnSync('cmd.exe', ['/d', '/c', 'git --version'], { cwd: folder, env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' }, encoding: 'utf8' });
    expect(r.stdout).toMatch(/git version/);
    expect(readdirSync(markers).length).toBe(before);
  });

  it("makes OtherBench's job git refuse the folder, and is what the engine's start guard sees", async () => {
    expect(plantedCommandIn(readdirSync(folder))).toMatch(/^git\.(cmd|bat)$/);
    mkdirSync(join(tmp, 'ob'));
    const jg = new JobGit({ root: join(tmp, 'ob'), branchPrefix: 'test' });
    await expect(jg.headOf(folder, 'test/x')).rejects.toThrow(/git\.(cmd|bat)/);
    expect(readdirSync(markers)).toEqual([]);
    // Refused before any git was started at all.
    expect(existsSync(join(tmp, 'ob', 'no-git-hooks'))).toBe(false);
  });
});
