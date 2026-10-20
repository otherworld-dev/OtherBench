import { describe, expect, it } from 'vitest';
import { APP_NAME_MAX, compareApps, githubRepoFromRemote, githubRepoFromRemotes, isGithubRepo } from '../src/domain/apps.js';
import type { App } from '../src/ports/store.js';

function app(id: string, name: string, sortOrder = 0): App {
  return { id, name, workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, sortOrder, createdAt: 0, updatedAt: 0 };
}

describe('githubRepoFromRemote', () => {
  it.each([
    ['https://github.com/otherworld-dev/OtherBench.git', 'otherworld-dev/OtherBench'],
    ['git@github.com:otherworld-dev/OtherBench.git', 'otherworld-dev/OtherBench'],
    ['ssh://git@github.com/a/b', 'a/b'],
    ['https://GitHub.com/a/b/', 'a/b'],
    ['https://git.ineedroot.com/adam/OtherBench.git', null],
    ['https://github.com/a', null],
  ])('%s -> %s', (url, expected) => {
    expect(githubRepoFromRemote(url)).toBe(expected);
  });
});

describe('githubRepoFromRemotes', () => {
  it('prefers github, then origin, then the first on GitHub', () => {
    expect(githubRepoFromRemotes([{ name: 'origin', url: 'https://git.ineedroot.com/adam/X.git' }, { name: 'github', url: 'git@github.com:o/X.git' }])).toBe('o/X');
    expect(githubRepoFromRemotes([{ name: 'other', url: 'git@github.com:p/Y.git' }, { name: 'origin', url: 'git@github.com:o/X.git' }])).toBe('o/X');
    expect(githubRepoFromRemotes([{ name: 'a', url: 'https://example.com/x/y' }, { name: 'b', url: 'git@github.com:p/Y.git' }])).toBe('p/Y');
    expect(githubRepoFromRemotes([{ name: 'origin', url: 'https://example.com/x/y' }])).toBeNull();
  });
});

describe('isGithubRepo', () => {
  it('accepts owner/name only', () => {
    expect(isGithubRepo('a/b')).toBe(true);
    expect(isGithubRepo('a/../b')).toBe(false);
    expect(isGithubRepo('a')).toBe(false);
    expect(isGithubRepo('-a/b')).toBe(false);
  });
});

describe('compareApps', () => {
  it('orders by sortOrder, then name ignoring case, then id', () => {
    const list = [app('3', 'beta', 1), app('2', 'Beta', 0), app('1', 'alpha', 0), app('0', 'beta', 0)];
    expect([...list].sort(compareApps).map((a) => a.id)).toEqual(['1', '0', '2', '3']);
  });
  it('has a name limit', () => {
    expect(APP_NAME_MAX).toBe(80);
  });
});
