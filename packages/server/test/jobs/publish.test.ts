import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobGit, scrubCredentials } from '../../src/jobs/git.js';

/**
 * Publishing a finished job's branch (docs/features/jobs.md,
 * "Publishing"), with real git and a local bare repository as the remote.
 */
let tmp: string;
let remote: string;
let app: string;
let folder: string;
let markers: string;
let jg: JobGit;
let head: string;
const JOB = 'cmwpublish000000001';
const BRANCH = `test/${JOB}`;

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const marker = (name: string): string => `node -e "require('fs').writeFileSync('${join(markers, name).replace(/\\/g, '/')}','x')"`;
const remoteRef = (ref: string): string | null => {
  try {
    return git(tmp, `--git-dir=${remote}`, 'rev-parse', '--verify', '--quiet', ref);
  } catch {
    return null;
  }
};
/** Everything of the app repository that a publish must leave alone. */
const appState = (): Record<string, string> => ({
  head: git(app, 'rev-parse', 'HEAD'),
  branch: git(app, 'branch', '--show-current'),
  branches: git(app, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
  index: git(app, 'diff', '--cached', '--name-status'),
  status: git(app, '-c', 'core.hooksPath=/nonexistent', 'status', '--porcelain'),
  wip: readFileSync(join(app, 'wip.txt'), 'utf8'),
});

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'otherbench-publish-'));
  remote = join(tmp, 'remote.git');
  app = join(tmp, 'app');
  markers = join(tmp, 'markers');
  mkdirSync(markers);
  mkdirSync(join(tmp, 'ob'));
  jg = new JobGit({ root: join(tmp, 'ob'), branchPrefix: 'test' });
  git(tmp, 'init', '-q', '--bare', '-b', 'dev', remote);
  git(tmp, 'clone', '-q', remote, app);
  writeFileSync(join(app, 'a.txt'), 'one\n');
  // The app already has CI: only a job's own changes to it are refused, not a repository that has it.
  mkdirSync(join(app, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(app, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  git(app, 'add', '.');
  git(app, 'commit', '-q', '-m', 'base');
  git(app, 'push', '-q', 'origin', 'dev');
  // The job: a clone of the app on its own branch, with a commit of its work.
  folder = join(tmp, 'jobs', JOB);
  await jg.cloneForJob({ source: app, dest: folder, startCommit: git(app, 'rev-parse', 'HEAD'), branch: BRANCH });
  writeFileSync(join(folder, 'a.txt'), 'one\ntwo\n');
  git(folder, '-c', 'core.hooksPath=/nonexistent', 'commit', '-q', '-am', 'job work');
  head = git(folder, 'rev-parse', 'HEAD');
  // Uncommitted work left in the job folder: never pushed, by construction.
  writeFileSync(join(folder, 'scratch.txt'), 'not committed\n');
  // Bait: hooks in the job folder, and in the app repository a pre-push and a reference-transaction hook.
  for (const hook of ['pre-push', 'reference-transaction', 'post-update', 'pre-receive']) writeFileSync(join(folder, '.git', 'hooks', hook), `#!/bin/sh\n${marker(`job-${hook}`)}\n`);
  for (const hook of ['pre-push', 'reference-transaction']) writeFileSync(join(app, '.git', 'hooks', hook), `#!/bin/sh\n${marker(`app-${hook}`)}\nexit 0\n`);
  // The app has its own work in progress.
  writeFileSync(join(app, 'wip.txt'), 'mine\n');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('publishing a job branch', () => {
  it('pushes exactly the reviewed commit as test/<id>, leaving the app repository as it was and running no hook', async () => {
    const before = appState();
    expect(await jg.publish({ appRepo: app, folder, jobId: JOB, branch: BRANCH, headCommit: head, remote: 'origin' })).toEqual({ ok: true, already: false });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBe(head);
    // Nothing else reached the remote: its only branches are dev and the job's, and no tags.
    expect(git(tmp, `--git-dir=${remote}`, 'for-each-ref', '--format=%(refname)').split('\n').sort()).toEqual(['refs/heads/dev', `refs/heads/${BRANCH}`].sort());
    // The commit came into the app repository under a private ref only.
    expect(git(app, 'rev-parse', `refs/otherbench-jobs/test/${JOB}`)).toBe(head);
    expect(appState()).toEqual(before);
    expect(readdirSync(markers)).toEqual([]);
    // The uncommitted file in the job folder isn't in what was pushed.
    expect(git(tmp, `--git-dir=${remote}`, 'ls-tree', '--name-only', head).split('\n')).toEqual(['.github', 'a.txt']);
  });

  it('is "already there" the second time, so a repeated task is safe', async () => {
    await jg.publish({ appRepo: app, folder, jobId: JOB, branch: BRANCH, headCommit: head, remote: 'origin' });
    expect(await jg.publish({ appRepo: app, folder, jobId: JOB, branch: BRANCH, headCommit: head, remote: 'origin' })).toEqual({ ok: true, already: true });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBe(head);
  });

  it('refuses when the remote already has the branch at another commit, and overwrites nothing', async () => {
    const other = git(app, 'rev-parse', 'HEAD');
    git(app, '-c', 'core.hooksPath=/nonexistent', 'push', '-q', 'origin', `${other}:refs/heads/${BRANCH}`);
    const r = await jg.publish({ appRepo: app, folder, jobId: JOB, branch: BRANCH, headCommit: head, remote: 'origin' });
    expect(r).toMatchObject({ ok: false, note: expect.stringMatching(/never overwrites/) });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBe(other);
  });

  it('refuses when the job branch moved after the result was sent', async () => {
    writeFileSync(join(folder, 'a.txt'), 'one\ntwo\nthree\n');
    git(folder, '-c', 'core.hooksPath=/nonexistent', 'commit', '-q', '-am', 'moved after review');
    const r = await jg.publish({ appRepo: app, folder, jobId: JOB, branch: BRANCH, headCommit: head, remote: 'origin' });
    expect(r).toMatchObject({ ok: false, note: expect.stringMatching(/moved after the result was sent/) });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBeNull();
  });

  it('refuses a remote the app repository does not have, a non-job branch, and a short commit id', async () => {
    expect(await jg.publish({ appRepo: app, folder, jobId: JOB, branch: BRANCH, headCommit: head, remote: 'gitea' })).toMatchObject({ ok: false, note: expect.stringMatching(/no remote called gitea/) });
    expect(await jg.publish({ appRepo: app, folder, jobId: JOB, branch: 'dev', headCommit: head, remote: 'origin' })).toMatchObject({ ok: false, note: expect.stringMatching(/not a job branch/) });
    expect(await jg.publish({ appRepo: app, folder, jobId: JOB, branch: BRANCH, headCommit: head.slice(0, 7), remote: 'origin' })).toMatchObject({ ok: false });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBeNull();
  });

  it('refuses any branch but <prefix>/<this job>, before any git runs', async () => {
    const run = vi.fn();
    const guarded = new JobGit({ root: join(tmp, 'ob'), branchPrefix: 'test', run });
    for (const branch of ['test/../main', 'main', `other/${JOB}`, 'test/cmwsomeotherjob0001', `test/${JOB}/x`]) {
      const r = await guarded.publish({ appRepo: app, folder, jobId: JOB, branch, headCommit: head, remote: 'origin' });
      expect(r, branch).toMatchObject({ ok: false });
    }
    expect(run).not.toHaveBeenCalled();
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBeNull();
    expect(guarded.jobBranchFor(JOB)).toBe(BRANCH);
  });

  it('refuses a branch whose commits touch CI config, however it was written, and pushes nothing', async () => {
    // Written and committed by plain git, as a sandboxed command could, past the file tools' rules.
    mkdirSync(join(folder, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(folder, '.github', 'workflows', 'leak.yml'), 'on: push\n');
    git(folder, '-c', 'core.hooksPath=/nonexistent', 'add', '.github');
    git(folder, '-c', 'core.hooksPath=/nonexistent', 'commit', '-q', '-m', 'more work');
    // An ordinary commit on top, so the CI change isn't the tip.
    writeFileSync(join(folder, 'a.txt'), 'one\ntwo\nthree\n');
    git(folder, '-c', 'core.hooksPath=/nonexistent', 'commit', '-q', '-am', 'tip');
    const tip = git(folder, 'rev-parse', 'HEAD');
    const r = await jg.publish({ appRepo: app, folder, jobId: JOB, branch: BRANCH, headCommit: tip, remote: 'origin' });
    expect(r).toMatchObject({ ok: false, note: expect.stringContaining('.github/workflows/leak.yml') });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBeNull();
  });

  it('still refuses CI config the app repository holds only on a fetched job branch', async () => {
    mkdirSync(join(folder, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(folder, '.github', 'workflows', 'leak.yml'), 'on: push\n');
    git(folder, '-c', 'core.hooksPath=/nonexistent', 'add', '.github');
    git(folder, '-c', 'core.hooksPath=/nonexistent', 'commit', '-q', '-m', 'more work');
    const tip = git(folder, 'rev-parse', 'HEAD');
    // An earlier job's branch fetched into the app repository for review, holding the same commits.
    git(app, 'fetch', '-q', join(folder, '.git'), `+refs/heads/${BRANCH}:refs/heads/test/cmwolderjob000001`);
    const r = await jg.publish({ appRepo: app, folder, jobId: JOB, branch: BRANCH, headCommit: tip, remote: 'origin' });
    expect(r).toMatchObject({ ok: false, note: expect.stringContaining('.github/workflows/leak.yml') });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBeNull();
  });

  it('refuses a job folder whose .git sends git elsewhere', async () => {
    writeFileSync(join(folder, '.git', 'commondir'), '../../elsewhere\n');
    const r = await jg.publish({ appRepo: app, folder, jobId: JOB, branch: BRANCH, headCommit: head, remote: 'origin' });
    expect(r).toMatchObject({ ok: false, note: expect.stringMatching(/commondir/) });
    expect(remoteRef(`refs/heads/${BRANCH}`)).toBeNull();
  });

  it('plants bait that plain git does run (the control)', () => {
    git(app, 'push', '-q', 'origin', 'dev:refs/heads/control');
    expect(readdirSync(markers)).toEqual(expect.arrayContaining(['app-pre-push']));
  });

  it('never lets a URL with credentials into a note', () => {
    expect(scrubCredentials("fatal: unable to access 'https://adam:ghp_secret@github.com/x/y.git/': 403")).toBe("fatal: unable to access 'https://***@github.com/x/y.git/': 403");
  });
});
