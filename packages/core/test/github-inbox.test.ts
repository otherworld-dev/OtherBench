import { describe, expect, it } from 'vitest';
import { appForRepo, notificationKind, parseNotification, sortNotifications } from '../src/domain/github-inbox.js';
import type { GithubNotification } from '../src/types/overview.js';

function raw(type: string, url: string | null, over: Record<string, unknown> = {}): unknown {
  return {
    id: '17', unread: true, reason: 'mention', updated_at: '2026-10-29T10:00:00Z',
    subject: { title: 'A title', url, type }, repository: { full_name: 'o/r' }, ...over,
  };
}

describe('parseNotification', () => {
  it('reads an issue, with its number and web address', () => {
    expect(parseNotification(raw('Issue', 'https://api.github.com/repos/o/r/issues/451'))).toEqual({
      id: '17', repo: 'o/r', kind: 'issue', title: 'A title', number: 451, reason: 'mention', unread: true,
      updatedAt: '2026-10-29T10:00:00Z', url: 'https://github.com/o/r/issues/451',
    });
  });
  it('gives a pull request its /pull/ address', () => {
    expect(parseNotification(raw('PullRequest', 'https://api.github.com/repos/o/r/pulls/456'))).toMatchObject({
      kind: 'pr', number: 456, url: 'https://github.com/o/r/pull/456',
    });
  });
  it("sends CI, which has no subject address, to the repo's Actions page", () => {
    expect(parseNotification(raw('CheckSuite', null, { reason: 'ci_activity', unread: false }))).toMatchObject({
      kind: 'ci', number: null, unread: false, url: 'https://github.com/o/r/actions',
    });
    expect(parseNotification(raw('WorkflowRun', null))).toMatchObject({ kind: 'ci', url: 'https://github.com/o/r/actions' });
  });
  it('maps a release or discussion address onto github.com', () => {
    expect(parseNotification(raw('Release', 'https://api.github.com/repos/o/r/releases/9'))).toMatchObject({
      kind: 'release', number: null, url: 'https://github.com/o/r/releases/9',
    });
    expect(parseNotification(raw('Discussion', 'https://api.github.com/repos/o/r/discussions/3'))).toMatchObject({ kind: 'discussion' });
  });
  it('falls back to the repo page for an address it does not recognise', () => {
    expect(parseNotification(raw('Commit', 'https://example.com/elsewhere'))).toMatchObject({ kind: 'other', number: null, url: 'https://github.com/o/r' });
  });
  it('drops an entry missing its id, repo or title', () => {
    expect(parseNotification(raw('Issue', null, { id: undefined }))).toBeNull();
    expect(parseNotification(raw('Issue', null, { repository: {} }))).toBeNull();
    expect(parseNotification(raw('Issue', null, { subject: { url: null, type: 'Issue' } }))).toBeNull();
    expect(parseNotification('nonsense')).toBeNull();
  });
});

describe('notificationKind', () => {
  it('names each subject type', () => {
    expect(['Issue', 'PullRequest', 'CheckSuite', 'WorkflowRun', 'Release', 'Discussion', 'RepositoryVulnerabilityAlert'].map(notificationKind)).toEqual([
      'issue', 'pr', 'ci', 'ci', 'release', 'discussion', 'other',
    ]);
  });
});

describe('appForRepo', () => {
  const apps = [{ id: 'a', githubRepo: null }, { id: 'b', githubRepo: 'Otherworld-Dev/Budget' }, { id: 'c', githubRepo: 'otherworld-dev/budget' }];
  it('matches regardless of case, the first app winning', () => {
    expect(appForRepo(apps, 'otherworld-dev/Budget')?.id).toBe('b');
  });
  it('is null for a repo no app has', () => {
    expect(appForRepo(apps, 'o/other')).toBeNull();
  });
});

describe('sortNotifications', () => {
  const n = (id: string, unread: boolean, updatedAt: string): GithubNotification => ({
    id, repo: 'o/r', kind: 'issue', title: id, number: 1, reason: 'mention', unread, updatedAt, url: 'u',
  });
  it('puts unread first, then newest', () => {
    const sorted = sortNotifications([n('old-read', false, '2026-10-01T00:00:00Z'), n('old-unread', true, '2026-10-02T00:00:00Z'), n('new-read', false, '2026-10-20T00:00:00Z'), n('new-unread', true, '2026-10-21T00:00:00Z')]);
    expect(sorted.map((x) => x.id)).toEqual(['new-unread', 'old-unread', 'new-read', 'old-read']);
  });
});
