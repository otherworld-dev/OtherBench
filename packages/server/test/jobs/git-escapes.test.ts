import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSafeBranchName, JobGit } from '../../src/jobs/git.js';

/**
 * The first guarantee for job folders: a job can write its folder's .git and
 * .claude, so OtherBench's own git on a job folder must run none of it. Each
 * vector is planted for real and shown to fire under plain git (the
 * positive control), then every call JobGit makes is run and nothing fires.
 */

let tmp: string;
let source: string;
let jobs: string;
let markers: string;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
/** A shell command (git runs config commands and hooks with its sh) that leaves a marker file named `name`. */
const marker = (name: string): string => `node -e "require('fs').writeFileSync('${join(markers, name).replace(/\\/g, '/')}','x')"`;
const fired = (): string[] => readdirSync(markers).sort();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'otherbench-jobgit-'));
  source = join(tmp, 'app');
  jobs = join(tmp, 'jobs');
  markers = join(tmp, 'markers');
  mkdirSync(source);
  mkdirSync(markers);
  git(source, 'init', '-q', '-b', 'dev');
  git(source, 'config', 'user.name', 'Adam');
  git(source, 'config', 'user.email', 'adam@example.invalid');
  writeFileSync(join(source, 'a.txt'), 'one\n');
  // Attributes that name drivers: harmless unless config defines them, which a job can't do on this machine.
  writeFileSync(join(source, '.gitattributes'), '* filter=evil diff=evil\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'base');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Everything a job could have planted in its folder from the sandbox. */
function plant(folder: string): void {
  const hooks = join(folder, '.git', 'hooks');
  for (const hook of ['pre-commit', 'post-commit', 'post-checkout', 'reference-transaction', 'pre-push', 'post-merge', 'post-rewrite', 'fsmonitor-watchman']) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\n${marker(`hook-${hook}`)}\n`);
  }
  mkdirSync(join(folder, 'evil-hooks'));
  writeFileSync(join(folder, 'evil-hooks', 'reference-transaction'), `#!/bin/sh\n${marker('hookspath')}\n`);
  const config = join(folder, '.git', 'config');
  const add = (key: string, value: string): string => git(folder, 'config', '--file', config, key, value);
  add('core.fsmonitor', marker('fsmonitor'));
  add('core.hooksPath', join(folder, 'evil-hooks').replace(/\\/g, '/'));
  add('filter.evil.clean', marker('filter-clean'));
  add('filter.evil.smudge', marker('filter-smudge'));
  add('diff.evil.textconv', marker('textconv'));
  add('diff.evil.command', marker('diff-command'));
  add('diff.external', marker('diff-external'));
  add('core.pager', marker('pager'));
  add('uploadpack.packObjectsHook', marker('pack-objects-hook'));
  writeFileSync(join(folder, '.git', 'info', 'attributes'), '* filter=evil diff=evil\n');
  // Claude Code's project settings, with a hook: nothing OtherBench's git does reads them, and a job's Claude Code loads no settings (job.test.ts in the engine).
  mkdirSync(join(folder, '.claude'));
  writeFileSync(join(folder, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: marker('claude-hook') }] }] } }));
}

describe('JobGit on a job folder a job has tampered with', () => {
  it('makes a clone with no remotes on its own branch, and runs nothing the folder planted', async () => {
    const jg = new JobGit({ root: join(tmp, 'otherbench'), branchPrefix: 'test' });
    mkdirSync(join(tmp, 'otherbench'));
    const dest = join(jobs, 'job1');
    const startCommit = git(source, 'rev-parse', 'dev').trim();
    const { baseCommit } = await jg.cloneForJob({ source, dest, startCommit, branch: 'test/job1' });
    expect(baseCommit).toBe(startCommit);
    expect(git(dest, 'remote').trim()).toBe('');
    expect(git(dest, 'branch', '--show-current').trim()).toBe('test/job1');
    expect(git(dest, 'config', 'user.name').trim()).toBe('Adam');
    // The sandbox's placeholders are never picked up by `git add -A`.
    expect(readFileSync(join(dest, '.git', 'info', 'exclude'), 'utf8')).toContain('/CLAUDE.md');

    // The job's work, committed as the agent would in the sandbox.
    writeFileSync(join(dest, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(dest, 'b.txt'), 'new\n');
    git(dest, '-c', 'core.hooksPath=/nonexistent', 'add', '.');
    git(dest, '-c', 'core.hooksPath=/nonexistent', 'commit', '-q', '-m', 'job work');
    plant(dest);

    const head = await jg.headOf(dest, 'test/job1');
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    const commits = await jg.commits(dest, baseCommit, head!);
    expect(commits.map((c) => c.subject)).toEqual(['job work']);
    const stat = await jg.diffstat(dest, baseCommit, head!);
    expect(stat).toMatchObject({ files: 2, insertions: 2, deletions: 0 });
    expect(stat.text).toContain('b.txt');
    const fetched = await jg.fetchInto({ appRepo: source, folder: dest, branch: 'test/job1' });
    expect(fetched).toBe(head);
    // Fetched, never checked out or merged.
    expect(git(source, 'branch', '--show-current').trim()).toBe('dev');
    expect(git(source, 'rev-parse', 'dev').trim()).toBe(baseCommit);

    expect(fired()).toEqual([]);

    // Positive control: the same folder under plain git does run what was planted.
    writeFileSync(join(dest, 'a.txt'), 'changed\n');
    git(dest, 'status', '--porcelain');
    try {
      git(dest, 'commit', '-q', '-am', 'x');
    } catch {
      // a hook or filter that fails may stop the commit; the markers are what count
    }
    const plain = fired();
    expect(plain).toEqual(expect.arrayContaining(['fsmonitor', 'filter-clean']));
    expect(plain.some((m) => m.startsWith('hook') || m === 'hookspath')).toBe(true);
    // And nothing at all ran Claude Code's settings hook: only Claude Code would, and a job's loads no settings.
    expect(plain).not.toContain('claude-hook');
  });

  it("won't touch a folder whose .git is a file pointing elsewhere, or that holds a stand-in for git", async () => {
    const jg = new JobGit({ root: join(tmp, 'otherbench'), branchPrefix: 'test' });
    mkdirSync(join(tmp, 'otherbench'));
    const dest = join(jobs, 'job2');
    await jg.cloneForJob({ source, dest, startCommit: git(source, 'rev-parse', 'dev').trim(), branch: 'test/job2' });

    writeFileSync(join(dest, 'git.exe'), 'MZ');
    await expect(jg.headOf(dest, 'test/job2')).rejects.toThrow(/git\.exe/);
    rmSync(join(dest, 'git.exe'));

    rmSync(join(dest, '.git'), { recursive: true, force: true });
    writeFileSync(join(dest, '.git'), `gitdir: ${join(source, '.git')}\n`);
    await expect(jg.headOf(dest, 'dev')).rejects.toThrow(/not a plain folder/);
  });

  it('refuses branch names git could read as an option or a range', async () => {
    for (const bad of ['--upload-pack=evil', '-x', 'a..b', 'a b', 'a/../b', '.hidden', 'x.lock', 'a//b', 'HEAD', '', 'dev;rm']) {
      expect(isSafeBranchName(bad), bad).toBe(false);
    }
    for (const good of ['dev', 'main', 'test/cmw123abc', 'feature/x-1.2_3']) expect(isSafeBranchName(good), good).toBe(true);
    const jg = new JobGit({ root: join(tmp, 'otherbench'), branchPrefix: 'test' });
    mkdirSync(join(tmp, 'otherbench'));
    await expect(jg.baseFor({ appRepo: source, remote: 'origin', baseBranch: '--upload-pack=touch /tmp/x' })).rejects.toThrow(/not a branch name/);
    await expect(jg.cloneForJob({ source, dest: join(jobs, 'x'), startCommit: '--upload-pack=x', branch: 'test/x' })).rejects.toThrow(/not a commit id/);
    expect(existsSync(join(jobs, 'x'))).toBe(false);
  });
});
