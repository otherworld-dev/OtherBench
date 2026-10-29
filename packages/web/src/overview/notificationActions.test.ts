import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Chat } from '@otherbench/core/ports/store.js';
import type { GithubNotification } from '@otherbench/core/types/overview.js';

const startChatFromIssue = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../code/startChatFromIssue.js', () => ({ startChatFromIssue }));
vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      chats: { ...actual.api.chats, create: vi.fn() },
      apps: { ...actual.api.apps, issues: { ...actual.api.apps.issues, get: vi.fn() }, pulls: { get: vi.fn() } },
    },
  };
});

import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { notificationDraft, startChatFromNotification } from './notificationActions.js';

const app = { id: 'a', name: 'Budget', githubRepo: 'o/budget' } as App;
const note = (over: Partial<GithubNotification>): GithubNotification => ({
  id: '1', repo: 'o/budget', kind: 'issue', title: 'A thing', number: 7, reason: 'mention', unread: true, updatedAt: '2026-10-29T10:00:00Z', url: 'https://github.com/o/budget/issues/7', ...over,
});

describe('notificationDraft', () => {
  it('drafts a PR with its URL, branch and body', () => {
    expect(notificationDraft(note({ kind: 'pr', number: 456 }), { title: 'Add sync', url: 'https://github.com/o/budget/pull/456', branch: 'feat/sync', body: 'Adds it.' })).toEqual({
      title: 'PR #456 Add sync',
      draft: 'PR #456 Add sync\nhttps://github.com/o/budget/pull/456\nBranch: feat/sync\n\nAdds it.',
    });
    expect(notificationDraft(note({ kind: 'pr', number: 456 }), { title: 'Add sync', url: 'u', branch: 'b', body: '  ' }).draft).toBe('PR #456 Add sync\nu\nBranch: b');
  });
  it('asks Claude to find out why CI failed', () => {
    expect(notificationDraft(note({ kind: 'ci', number: null, title: 'CI workflow run failed for main branch', url: 'https://github.com/o/budget/actions' }), null)).toEqual({
      title: 'CI: CI workflow run failed for main branch',
      draft: 'CI workflow run failed for main branch\nhttps://github.com/o/budget/actions\n\nFind out why this failed and fix it.',
    });
  });
  it('drafts anything else with its title and URL', () => {
    expect(notificationDraft(note({ kind: 'release', number: null, title: 'v2.41.0', url: 'https://github.com/o/budget/releases/9' }), null)).toEqual({
      title: 'v2.41.0',
      draft: 'v2.41.0\nhttps://github.com/o/budget/releases/9',
    });
  });
});

describe('startChatFromNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOtherBenchStore.setState({ chats: [], composerPrefills: {} });
    vi.mocked(api.chats.create).mockResolvedValue({ id: 'c-new', appId: 'a', title: 't' } as Chat);
  });

  it('starts an issue chat the way the Issues tab does', async () => {
    const issue = { number: 7, title: 'A thing' };
    vi.mocked(api.apps.issues.get).mockResolvedValue(issue as never);
    await startChatFromNotification(app, note({}));
    expect(api.apps.issues.get).toHaveBeenCalledWith('a', 7);
    expect(startChatFromIssue).toHaveBeenCalledWith(app, issue);
    expect(api.chats.create).not.toHaveBeenCalled();
  });

  it('starts a PR chat in the app, prefilled and opened but not sent', async () => {
    vi.mocked(api.apps.pulls.get).mockResolvedValue({ number: 456, title: 'Add sync', body: '', url: 'u', branch: 'feat/sync' });
    await startChatFromNotification(app, note({ kind: 'pr', number: 456 }));
    expect(api.apps.pulls.get).toHaveBeenCalledWith('a', 456);
    expect(api.chats.create).toHaveBeenCalledWith({ appId: 'a', title: 'PR #456 Add sync' });
    const state = useOtherBenchStore.getState();
    expect(state.composerPrefills['c-new']).toBe('PR #456 Add sync\nu\nBranch: feat/sync');
    expect(state.activeChatId).toBe('c-new');
  });
});
