import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Chat } from '@otherbench/core/ports/store.js';
import type { Overview } from '@otherbench/core/types/overview.js';
import type { IssueDetail, IssueSummary } from '@otherbench/core/types/code.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      apps: { ...actual.api.apps, issues: { list: vi.fn(), get: vi.fn(), comment: vi.fn(), close: vi.fn(), reopen: vi.fn() } },
      overview: { ...actual.api.overview, markDone: vi.fn() },
    },
  };
});
vi.mock('../desktop/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../desktop/bridge.js')>();
  return { ...actual, openInBrowser: vi.fn(async () => undefined) };
});
vi.mock('./startChatFromIssue.js', () => ({ startChatFromIssue: vi.fn(async () => undefined) }));

import { openInBrowser } from '../desktop/bridge.js';
import { ApiError, api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { IssuesTab } from './IssuesTab.js';
import { startChatFromIssue } from './startChatFromIssue.js';

const app = (over: Partial<App> = {}): App => ({
  id: 'a1', name: 'OtherBench', workspace: null, githubRepo: 'otherworld-dev/OtherBench', linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const chat = (id: string, appId: string | null): Chat => ({
  id, title: `Chat ${id}`, profileId: 'prof', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: null, appId, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
});
const summary = (n: number, title: string, over: Partial<IssueSummary> = {}): IssueSummary => ({
  number: n, title, state: 'open', author: 'adam', labels: [], comments: 0, createdAt: `2026-10-${String(n % 28 + 1).padStart(2, '0')}T10:00:00Z`, updatedAt: '2026-10-20T10:00:00Z',
  url: `https://github.com/otherworld-dev/OtherBench/issues/${n}`, ...over,
});
const detail = (over: Partial<IssueDetail> = {}): IssueDetail => ({
  ...summary(48, 'MCP tools vanish on reconnect', { comments: 1 }),
  body: 'After a **reconnect** the tools are gone.',
  commentList: [{ author: 'bob', body: 'Seen it too.', createdAt: '2026-10-19T10:00:00Z' }],
  ...over,
});

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  vi.mocked(api.apps.issues.list).mockResolvedValue({
    repo: 'otherworld-dev/OtherBench',
    issues: [summary(45, 'Usage rounding', { createdAt: '2026-10-01T10:00:00Z' }), summary(48, 'MCP tools vanish on reconnect', { labels: ['bug'], comments: 3, createdAt: '2026-10-10T10:00:00Z' })],
  });
  vi.mocked(api.apps.issues.get).mockResolvedValue(detail());
  vi.mocked(api.apps.issues.comment).mockResolvedValue(undefined);
  vi.mocked(api.apps.issues.close).mockResolvedValue(undefined);
  vi.mocked(api.apps.issues.reopen).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IssuesTab', () => {
  it('lists the open issues newest first, with number, title, labels and comment count', async () => {
    render(<IssuesTab app={app()} owner="c1" />);
    const row = await screen.findByTestId('issue-row-48');
    expect(row).toHaveTextContent('#48');
    expect(row).toHaveTextContent('MCP tools vanish on reconnect');
    expect(within(row).getByText('bug')).toBeInTheDocument();
    expect(within(row).getByLabelText('3 comments')).toBeInTheDocument();
    expect(api.apps.issues.list).toHaveBeenCalledWith('a1', 'open');
    const rows = within(screen.getByRole('list', { name: 'Issues' })).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-issue'))).toEqual(['48', '45']);
    expect(screen.getByText('otherworld-dev/OtherBench · 2 open')).toBeInTheDocument();
  });

  it('a list that hit the fetch limit says "100+", open or closed, since there may be more (M8)', async () => {
    const full = Array.from({ length: 100 }, (_, i) => summary(i + 1, `Issue ${i + 1}`));
    vi.mocked(api.apps.issues.list).mockResolvedValue({ repo: 'otherworld-dev/OtherBench', issues: full });
    const user = userEvent.setup();
    render(<IssuesTab app={app()} owner="c1" />);
    expect(await screen.findByText('otherworld-dev/OtherBench · 100+ open')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Closed' }));
    expect(await screen.findByText('otherworld-dev/OtherBench · 100+ closed')).toBeInTheDocument();
  });

  it('the Closed toggle lists closed issues', async () => {
    const user = userEvent.setup();
    render(<IssuesTab app={app()} owner="c1" />);
    await screen.findByTestId('issue-row-48');
    await user.click(screen.getByRole('button', { name: 'Closed' }));
    await waitFor(() => expect(api.apps.issues.list).toHaveBeenLastCalledWith('a1', 'closed'));
    expect(screen.getByRole('button', { name: 'Closed' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a click shows the body as markdown, the comments, and a link to GitHub through the default browser', async () => {
    const user = userEvent.setup();
    render(<IssuesTab app={app()} owner="c1" />);
    await user.click(await screen.findByTestId('issue-row-48'));
    const view = await screen.findByTestId('issue-detail');
    expect(api.apps.issues.get).toHaveBeenCalledWith('a1', 48);
    expect(within(view).getByRole('heading', { name: '#48 MCP tools vanish on reconnect' })).toBeInTheDocument();
    expect(within(view).getByText('reconnect').tagName).toBe('STRONG');
    expect(within(view).getByText('Seen it too.')).toBeInTheDocument();
    await user.click(within(view).getByRole('link', { name: 'Open on GitHub' }));
    expect(openInBrowser).toHaveBeenCalledWith('https://github.com/otherworld-dev/OtherBench/issues/48');
    await user.click(screen.getByRole('button', { name: 'Back to issues' }));
    expect(await screen.findByTestId('issue-row-48')).toBeInTheDocument();
  });

  it('Close closes the issue and Comment posts the comment, each refetched after', async () => {
    const user = userEvent.setup();
    render(<IssuesTab app={app()} owner="c1" />);
    await user.click(await screen.findByTestId('issue-row-48'));
    await screen.findByTestId('issue-detail');

    await user.type(screen.getByRole('textbox', { name: 'Comment' }), 'text');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(api.apps.issues.comment).toHaveBeenCalledWith('a1', 48, 'text'));
    await waitFor(() => expect(api.apps.issues.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Comment' })).toHaveValue(''));

    vi.mocked(api.apps.issues.get).mockResolvedValue(detail({ state: 'closed' }));
    await user.click(screen.getByRole('button', { name: 'Close issue' }));
    await waitFor(() => expect(api.apps.issues.close).toHaveBeenCalledWith('a1', 48));
    expect(await screen.findByRole('button', { name: 'Reopen issue' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reopen issue' }));
    await waitFor(() => expect(api.apps.issues.reopen).toHaveBeenCalledWith('a1', 48));
  });

  it('"Start a chat on this" starts a chat from the issue', async () => {
    const user = userEvent.setup();
    const a = app();
    render(<IssuesTab app={a} owner="c1" />);
    await user.click(await screen.findByTestId('issue-row-48'));
    await screen.findByTestId('issue-detail');
    await user.click(screen.getByRole('button', { name: 'Start a chat on this' }));
    expect(startChatFromIssue).toHaveBeenCalledWith(a, detail());
  });

  it("a row's Chat button starts a chat from that issue without opening it", async () => {
    const user = userEvent.setup();
    const a = app();
    render(<IssuesTab app={a} owner="c1" />);
    await user.click(await screen.findByRole('button', { name: 'Start a chat on #48' }));
    await waitFor(() => expect(startChatFromIssue).toHaveBeenCalledWith(a, detail()));
    expect(api.apps.issues.get).toHaveBeenCalledWith('a1', 48);
    expect(screen.queryByTestId('issue-detail')).not.toBeInTheDocument();
  });

  it("a row's Chat button that fails says why", async () => {
    vi.mocked(api.apps.issues.get).mockRejectedValue(new ApiError(409, 'gh is not logged in.', undefined, { code: 'gh-signed-out' }));
    render(<IssuesTab app={app()} owner="c1" />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Start a chat on #48' }));
    expect(await screen.findByText(/gh isn't signed in/)).toBeInTheDocument();
  });

  it('refetches the list when the window is focused (spec "Calls I made": refresh on focus)', async () => {
    render(<IssuesTab app={app()} owner="c1" />);
    await screen.findByTestId('issue-row-48');
    expect(api.apps.issues.list).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(api.apps.issues.list).toHaveBeenCalledTimes(2));
  });

  it("refetches after a turn finishes in one of the app's chats, but not another app's", async () => {
    useOtherBenchStore.setState({ chats: [chat('c1', 'a1'), chat('c2', 'a2')] });
    render(<IssuesTab app={app()} owner="c1" />);
    await screen.findByTestId('issue-row-48');
    act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'turn-finished', chatId: 'c2', messageId: 'm1', status: 'complete' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.apps.issues.list).toHaveBeenCalledTimes(1);
    act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'turn-finished', chatId: 'c1', messageId: 'm2', status: 'complete' }));
    await waitFor(() => expect(api.apps.issues.list).toHaveBeenCalledTimes(2));
  });

  it('an open issue is fetched again on focus', async () => {
    const user = userEvent.setup();
    render(<IssuesTab app={app()} owner="c1" />);
    await user.click(await screen.findByTestId('issue-row-48'));
    await screen.findByTestId('issue-detail');
    expect(api.apps.issues.get).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(api.apps.issues.get).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('issue-detail')).toBeInTheDocument();
  });

  it('each owner keeps its own issue open, and switching back shows it at once (one Issues view per chat)', async () => {
    const user = userEvent.setup();
    const a = app();
    const { rerender } = render(<IssuesTab key="c1" app={a} owner="c1" />);
    await user.click(await screen.findByTestId('issue-row-48'));
    await screen.findByTestId('issue-detail');
    expect(useOtherBenchStore.getState().issueViews['c1']).toEqual({ state: 'open', selected: 48 });

    rerender(<IssuesTab key="c2" app={a} owner="c2" />);
    expect(screen.queryByTestId('issue-detail')).not.toBeInTheDocument();
    // The list is gh's last answer, shown before it's fetched again.
    expect(screen.getByTestId('issue-row-48')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Closed' }));

    vi.mocked(api.apps.issues.get).mockReturnValue(new Promise(() => {}));
    rerender(<IssuesTab key="c1" app={a} owner="c1" />);
    expect(screen.getByTestId('issue-detail')).toHaveTextContent('#48 MCP tools vanish on reconnect');
    expect(useOtherBenchStore.getState().issueViews['c2']).toEqual({ state: 'closed', selected: null });
  });

  it('a half-written comment stays with its chat across a switch', async () => {
    const user = userEvent.setup();
    const a = app();
    useOtherBenchStore.getState().setIssueView('c1', { selected: 48 });
    useOtherBenchStore.getState().setIssueView('c2', { selected: 48 });
    const { rerender } = render(<IssuesTab key="c1" app={a} owner="c1" />);
    await user.type(await screen.findByRole('textbox', { name: 'Comment' }), 'half done');
    rerender(<IssuesTab key="c2" app={a} owner="c2" />);
    expect(await screen.findByRole('textbox', { name: 'Comment' })).toHaveValue('');
    rerender(<IssuesTab key="c1" app={a} owner="c1" />);
    expect(await screen.findByRole('textbox', { name: 'Comment' })).toHaveValue('half done');
  });

  it('gh-signed-out shows its one line', async () => {
    vi.mocked(api.apps.issues.list).mockRejectedValue(new ApiError(409, 'gh is not logged in.', undefined, { code: 'gh-signed-out' }));
    render(<IssuesTab app={app()} owner="c1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent("gh isn't signed in. Run `gh auth login`");
  });

  it('no-github-repo shows its one line', async () => {
    vi.mocked(api.apps.issues.list).mockRejectedValue(new ApiError(409, 'This app has no GitHub repo.', undefined, { code: 'no-github-repo' }));
    render(<IssuesTab app={app()} owner="c1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No GitHub repo set for this app');
  });

  it('an app with no GitHub repo says so without asking the server', async () => {
    render(<IssuesTab app={app({ githubRepo: null })} owner="c1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No GitHub repo set for this app');
    expect(api.apps.issues.list).not.toHaveBeenCalled();
  });

  it("gh-failed shows the server's line, with gh's stderr behind a disclosure", async () => {
    vi.mocked(api.apps.issues.list).mockRejectedValue(new ApiError(409, 'HTTP 502: bad gateway', undefined, { code: 'gh-failed', stderr: 'HTTP 502: bad gateway\nretry later' }));
    render(<IssuesTab app={app()} owner="c1" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('HTTP 502: bad gateway');
    expect(within(alert).getByText('Details')).toBeInTheDocument();
    expect(within(alert).getByText(/retry later/)).toBeInTheDocument();
  });

  describe('in your inbox', () => {
    const inbox = (): Overview => ({
      checkedAt: 1, checking: false, githubLogin: 'me', loginMismatches: [], unreachableMachines: [], total: 2,
      tiles: [{
        key: 'a1', appId: 'a1', name: 'OtherBench', count: 2, faded: false, chats: [], deck: null, deckError: null,
        notificationsError: null, notificationsMore: false,
        notifications: [
          { id: '901', repo: 'o/r', kind: 'issue', title: 'x', number: 48, reason: 'mention', unread: true, updatedAt: new Date().toISOString(), url: '' },
          // A PR with the same number as an issue in the list is not the issue.
          { id: '902', repo: 'o/r', kind: 'pr', title: 'y', number: 45, reason: 'review_requested', unread: true, updatedAt: new Date().toISOString(), url: '' },
        ],
      }],
    });

    it('marks only the issues in the inbox and marks one done', async () => {
      const next = { ...inbox(), tiles: [{ ...inbox().tiles[0]!, notifications: [] }] };
      vi.mocked(api.overview.markDone).mockResolvedValue(next);
      useOtherBenchStore.setState({ overview: inbox() });
      const user = userEvent.setup();
      render(<IssuesTab app={app()} owner="c1" />);
      expect(await screen.findByTestId('issue-inbox-48')).toHaveTextContent('in your inbox');
      expect(screen.queryByTestId('issue-inbox-45')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Done: #45' })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Done: #48' }));
      expect(api.overview.markDone).toHaveBeenCalledWith('901');
      await waitFor(() => expect(screen.queryByTestId('issue-inbox-48')).toBeNull());
      expect(useOtherBenchStore.getState().overview).toBe(next);
    });

    it('the issue view has a Done button only when the issue is in the inbox', async () => {
      useOtherBenchStore.setState({ overview: inbox() });
      useOtherBenchStore.getState().setIssueView('c1', { selected: 48 });
      const user = userEvent.setup();
      render(<IssuesTab app={app()} owner="c1" />);
      await screen.findByTestId('issue-detail');
      vi.mocked(api.overview.markDone).mockResolvedValue({ ...inbox(), tiles: [] });
      await user.click(screen.getByRole('button', { name: 'Done' }));
      expect(api.overview.markDone).toHaveBeenCalledWith('901');
    });

    it('the issue view has no Done when the issue is not in the inbox', async () => {
      useOtherBenchStore.setState({ overview: inbox() });
      useOtherBenchStore.getState().setIssueView('c1', { selected: 45 });
      vi.mocked(api.apps.issues.get).mockResolvedValue(detail({ number: 45 }));
      render(<IssuesTab app={app()} owner="c1" />);
      await screen.findByTestId('issue-detail');
      expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    });
  });
});
