import { describe, expect, it } from 'vitest';
import { parseBranches, parseRemotes, parseStatusV2 } from '../../src/code/git-parse.js';

const Z = '\0';
const H = '1111111111111111111111111111111111111111';

describe('parseStatusV2', () => {
  it('reads a branch with an upstream, ahead 2 behind 1', () => {
    const out = [`# branch.oid ${H}`, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', ''].join(Z);
    expect(parseStatusV2(out)).toEqual({ branch: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 1, files: [] });
  });

  it('reads a branch with no upstream', () => {
    const out = [`# branch.oid ${H}`, '# branch.head feature/x', ''].join(Z);
    expect(parseStatusV2(out)).toMatchObject({ branch: 'feature/x', detached: false, upstream: null, ahead: 0, behind: 0 });
  });

  it('reads a detached head', () => {
    const out = [`# branch.oid ${H}`, '# branch.head (detached)', ''].join(Z);
    expect(parseStatusV2(out)).toMatchObject({ branch: null, detached: true });
  });

  it('reads an unborn branch', () => {
    const out = ['# branch.oid (initial)', '# branch.head trunk', ''].join(Z);
    expect(parseStatusV2(out)).toMatchObject({ branch: 'trunk', detached: false });
  });

  it('reads a renamed file with its original path', () => {
    const out = ['# branch.head main', `2 R. N... 100644 100644 100644 ${H} ${H} R100 new name.txt`, 'old.txt', ''].join(Z);
    expect(parseStatusV2(out).files).toEqual([{ path: 'new name.txt', origPath: 'old.txt', index: 'R', worktree: ' ' }]);
  });

  it('reads modified, untracked and spaced paths', () => {
    const out = ['# branch.head main', `1 .M N... 100644 100644 100644 ${H} ${H} dir/a b.txt`, '? new file.txt', '! ignored.log', ''].join(Z);
    expect(parseStatusV2(out).files).toEqual([
      { path: 'dir/a b.txt', index: ' ', worktree: 'M' },
      { path: 'new file.txt', index: '?', worktree: '?' },
    ]);
  });

  it('reads an unmerged entry', () => {
    const out = ['# branch.head main', `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.txt`, ''].join(Z);
    expect(parseStatusV2(out).files).toEqual([{ path: 'conflict.txt', index: 'U', worktree: 'U' }]);
  });
});

describe('parseBranches', () => {
  it('splits the HEAD marker from the name', () => {
    expect(parseBranches('*\0main\n \0feature/x\n')).toEqual([
      { name: 'main', current: true },
      { name: 'feature/x', current: false },
    ]);
  });
});

describe('parseRemotes', () => {
  it('keeps only the fetch lines', () => {
    const out = 'origin\thttps://h/a.git (fetch)\norigin\thttps://h/a.git (push)\nup\tgit@h:b.git (fetch)\n';
    expect(parseRemotes(out)).toEqual([
      { name: 'origin', url: 'https://h/a.git' },
      { name: 'up', url: 'git@h:b.git' },
    ]);
  });
});
