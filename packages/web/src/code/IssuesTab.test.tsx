import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@otherbench/core/ports/store.js';
import type { IssueDetail, IssueSummary } from '@otherbench/core/types/code.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      apps: { ...actual.api.apps, issues: { list: vi.fn(), get: vi.fn(), comment: vi.fn(), close: vi.fn(), reopen: vi.fn() } },
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
  id: 'a1', name: 'OtherBench', workspace: null, githubRepo: 'otherworld-dev/OtherBench', linkedProjectId: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
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
    render(<IssuesTab app={app()} />);
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

  it('the Closed toggle lists closed issues', async () => {
    const user = userEvent.setup();
    render(<IssuesTab app={app()} />);
    await screen.findByTestId('issue-row-48');
    await user.click(screen.getByRole('button', { name: 'Closed' }));
    await waitFor(() => expect(api.apps.issues.list).toHaveBeenLastCalledWith('a1', 'closed'));
    expect(screen.getByRole('button', { name: 'Closed' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a click shows the body as markdown, the comments, and a link to GitHub through the default browser', async () => {
    const user = userEvent.setup();
    render(<IssuesTab app={app()} />);
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
    render(<IssuesTab app={app()} />);
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
    render(<IssuesTab app={a} />);
    await user.click(await screen.findByTestId('issue-row-48'));
    await screen.findByTestId('issue-detail');
    await user.click(screen.getByRole('button', { name: 'Start a chat on this' }));
    expect(startChatFromIssue).toHaveBeenCalledWith(a, detail());
  });

  it('gh-signed-out shows its one line', async () => {
    vi.mocked(api.apps.issues.list).mockRejectedValue(new ApiError(409, 'gh is not logged in.', undefined, { code: 'gh-signed-out' }));
    render(<IssuesTab app={app()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent("gh isn't signed in. Run `gh auth login`");
  });

  it('no-github-repo shows its one line', async () => {
    vi.mocked(api.apps.issues.list).mockRejectedValue(new ApiError(409, 'This app has no GitHub repo.', undefined, { code: 'no-github-repo' }));
    render(<IssuesTab app={app()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No GitHub repo set for this app');
  });

  it('an app with no GitHub repo says so without asking the server', async () => {
    render(<IssuesTab app={app({ githubRepo: null })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No GitHub repo set for this app');
    expect(api.apps.issues.list).not.toHaveBeenCalled();
  });

  it("gh-failed shows the server's line, with gh's stderr behind a disclosure", async () => {
    vi.mocked(api.apps.issues.list).mockRejectedValue(new ApiError(409, 'HTTP 502: bad gateway', undefined, { code: 'gh-failed', stderr: 'HTTP 502: bad gateway\nretry later' }));
    render(<IssuesTab app={app()} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('HTTP 502: bad gateway');
    expect(within(alert).getByText('Details')).toBeInTheDocument();
    expect(within(alert).getByText(/retry later/)).toBeInTheDocument();
  });
});
