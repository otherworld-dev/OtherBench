import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveExecutable } from '@otherbench/tools/mcp/spawn.js';
import { GitError, gitEnv, git } from '../../src/code/git.js';
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

  it('treats pathspecs literally (F1)', async () => {
    const dir = repo();
    writeFileSync(join(dir, '[a].txt'), 'x\n');
    writeFileSync(join(dir, 'a.txt'), 'y\n');
    await git.commit(dir, 'lit', ['[a].txt']);
    expect((await git.status(dir)).files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('commits a symlink itself, not its target (F2)', async (ctx) => {
    const dir = repo();
    writeFileSync(join(dir, 'real.txt'), 'r\n');
    try {
      symlinkSync('real.txt', join(dir, 'link.txt'));
    } catch {
      ctx.skip();
    }
    await git.commit(dir, 'link', ['link.txt']);
    expect(g(dir, 'ls-tree', '-r', '--name-only', 'HEAD').trim()).toBe('link.txt');
  });

  it('works when the root is reached through a junction (F2)', async (ctx) => {
    if (process.platform !== 'win32') return ctx.skip();
    const dir = repo();
    const via = join(tmp(), 'via');
    try {
      symlinkSync(dir, via, 'junction');
    } catch {
      return ctx.skip();
    }
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    await git.commit(via, 'j', ['a.txt']);
    expect((await git.status(via)).files).toEqual([]);
  });

  it('does not run a repo-configured fsmonitor (F3)', async () => {
    const dir = repo();
    const marker = join(dir, '..', `fsm-${Date.now()}.txt`);
    made.push(marker);
    g(dir, 'config', 'core.fsmonitor', `echo ran > "${marker.replace(/\\/g, '/')}"`);
    await git.status(dir);
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false);
  });

  it('bounds a whole-tree diff of many untracked files (F4)', async () => {
    const dir = repo();
    for (let i = 0; i < 300; i++) writeFileSync(join(dir, `f${i}.txt`), `line ${i}\n`);
    const out = await git.diff(dir);
    expect(out).toContain('+line 0');
    expect(out.trimEnd().endsWith('... diff truncated')).toBe(true);
    expect(out).not.toContain('+line 299');
  }, 120_000);

  it('refuses an app root that is not the repo top level (F10)', async () => {
    const dir = repo();
    mkdirSync(join(dir, 'sub'));
    expect(await code(git.status(join(dir, 'sub')))).toBe('not-a-repo');
  });

  it('redacts credentials in remotes (F7)', async () => {
    const dir = repo();
    g(dir, 'remote', 'add', 'origin', 'https://u:tok@example.com/a.git');
    expect(await git.remotes(dir)).toEqual([{ name: 'origin', url: 'https://example.com/a.git' }]);
  });
});

describe('gitEnv (F6)', () => {
  it('strips repo-redirecting variables and adds the fixed ones', () => {
    const env = gitEnv({
      PATH: '/bin', GIT_DIR: 'x', git_work_tree: 'x', GIT_INDEX_FILE: 'x', GIT_OBJECT_DIRECTORY: 'x',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'x',
      OTHERBENCH_TOKEN: 't',
    });
    expect(Object.keys(env).sort()).toEqual(['GH_NO_UPDATE_NOTIFIER', 'GH_PROMPT_DISABLED', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'NO_COLOR', 'PATH']);
  });
});
