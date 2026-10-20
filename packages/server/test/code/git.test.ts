import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveExecutable } from '@otherbench/tools/mcp/spawn.js';
import { GitError, git } from '../../src/code/git.js';
import { ExecutableMissingError, runProcess } from '../../src/code/process.js';

const hasGit = spawnSync('git', ['--version']).status === 0;
const made: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ob-git-'));
  made.push(dir);
  return dir;
}
function g(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}
/** A temp repo with a local identity, so commits work on CI without global config. */
function repo(): string {
  const dir = tmp();
  g(dir, 'init', '-q');
  g(dir, 'config', 'user.email', 't@example.com');
  g(dir, 'config', 'user.name', 'T');
  g(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}
async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GitError) return e.code;
    throw e;
  }
  return 'resolved';
}

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('runProcess', () => {
  it('rejects with ExecutableMissingError for a command that does not exist', async () => {
    await expect(runProcess('definitely-not-a-command-xyz', [], { cwd: tmpdir() })).rejects.toBeInstanceOf(ExecutableMissingError);
  });
  it('runs node, normalising CRLF and passing input', async () => {
    const script = "process.stdin.pipe(process.stdout); process.stderr.write('e\\r\\n')";
    const r = await runProcess(process.execPath, ['-e', script], { cwd: tmpdir(), input: 'a\r\nb' });
    expect(r).toMatchObject({ code: 0, stdout: 'a\nb', stderr: 'e\n', timedOut: false });
  });
  it('kills on timeout', async () => {
    const r = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { cwd: tmpdir(), timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  }, 15_000);
});

describe.skipIf(!hasGit)('git service', () => {
  it('resolves git through resolveExecutable', () => {
    expect(resolveExecutable('git')).toBeTruthy();
  });

  it('status on a fresh repo names the unborn branch with ahead/behind 0', async () => {
    const dir = repo();
    const unborn = g(dir, 'symbolic-ref', '--short', 'HEAD').trim();
    const s = await git.status(dir);
    expect(s.branch).toBe(unborn);
    expect(s).toMatchObject({ ahead: 0, behind: 0, detached: false, files: [] });
  });

  it('status lists a new file as untracked', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'hi\n');
    const s = await git.status(dir);
    expect(s.files).toEqual([{ path: 'a.txt', index: '?', worktree: '?' }]);
  });

  it('commit all returns a sha and leaves a clean tree; diff shows changes', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const { sha } = await git.commit(dir, 'first', 'all');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await git.status(dir)).files).toEqual([]);
    writeFileSync(join(dir, 'a.txt'), 'one\nnew line\n');
    expect(await git.diff(dir, 'a.txt')).toContain('+new line');
    expect(await git.diff(dir)).toContain('+new line');
  });

  it('commit with explicit paths commits only those', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    await git.commit(dir, 'only a', ['a.txt']);
    expect((await git.status(dir)).files.map((f) => f.path)).toEqual(['b.txt']);
  });

  it('diff of an untracked file shows it as added', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'u.txt'), 'fresh\n');
    expect(await git.diff(dir, 'u.txt')).toContain('+fresh');
  });

  it('commit with an empty message is git-failed', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    expect(await code(git.commit(dir, '  ', 'all'))).toBe('git-failed');
  });

  it('createBranch then branches shows it current; checkout switches back', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    await git.commit(dir, 'first', 'all');
    const first = g(dir, 'symbolic-ref', '--short', 'HEAD').trim();
    await git.createBranch(dir, 'feature/x');
    expect(await git.branches(dir)).toContainEqual({ name: 'feature/x', current: true });
    await git.checkout(dir, first);
    expect((await git.branches(dir)).find((b) => b.current)?.name).toBe(first);
  });

  it('refuses hostile branch names with bad-branch', async () => {
    const dir = repo();
    expect(await code(git.checkout(dir, '-f'))).toBe('bad-branch');
    expect(await code(git.checkout(dir, '--upload-pack=x'))).toBe('bad-branch');
    expect(await code(git.createBranch(dir, 'a..b'))).toBe('bad-branch');
    expect(await code(git.createBranch(dir, 'has space'))).toBe('bad-branch');
    expect(await code(git.createBranch(dir, ''))).toBe('bad-branch');
  });

  it('refuses paths outside the root with bad-path', async () => {
    const dir = repo();
    const outside = resolve(dir, '..', 'outside.txt');
    expect(await code(git.diff(dir, '../outside.txt'))).toBe('bad-path');
    expect(await code(git.diff(dir, outside))).toBe('bad-path');
    expect(await code(git.commit(dir, 'm', ['../x']))).toBe('bad-path');
  });

  it('accepts a nested path inside the root', async () => {
    const dir = repo();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'n.txt'), 'n\n');
    expect(await git.diff(dir, 'sub/n.txt')).toContain('+n');
  });

  it('status on a plain folder is not-a-repo', async () => {
    // A folder under tmpdir is not inside any repo.
    expect(await code(git.status(tmp()))).toBe('not-a-repo');
  });

  it('remotes lists fetch urls', async () => {
    const dir = repo();
    g(dir, 'remote', 'add', 'origin', 'https://example.com/a.git');
    expect(await git.remotes(dir)).toEqual([{ name: 'origin', url: 'https://example.com/a.git' }]);
  });
});
