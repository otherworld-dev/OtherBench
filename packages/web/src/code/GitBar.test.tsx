import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Chat } from '@otherbench/core/ports/store.js';
import type { GitStatus } from '@otherbench/core/types/code.js';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      apps: {
        ...actual.api.apps,
        git: { status: vi.fn(), diff: vi.fn(), commit: vi.fn(), pull: vi.fn(), push: vi.fn(), branches: vi.fn(), checkout: vi.fn(), branch: vi.fn() },
      },
    },
  };
});
const openPath = vi.fn();
vi.mock('../viewer/ViewerContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../viewer/ViewerContext.js')>();
  return { ...actual, viewerActionsFor: vi.fn(() => ({ ...actual.viewerActionsFor('x'), openPath })) };
});

import { ApiError, api, type PeersOverview } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { viewerActionsFor } from '../viewer/ViewerContext.js';
import { GitBar } from './GitBar.js';

const app: App = {
  id: 'a1', name: 'OtherBench', workspace: null, workspaceRoot: 'E:\\Git\\OtherBench', githubRepo: null, linkedProjectId: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1,
};
const chat = (over: Partial<Chat> = {}): Chat => ({
  id: 'c1', title: 'Fix it', profileId: 'prof', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: null, appId: 'a1', memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const machines = {
  self: { id: 'node-self', name: 'Laptop', fingerprint: 'f' },
  listening: { running: false, addresses: [] },
  peers: [{ nodeId: 'node-pc', name: 'PC', status: 'reachable', since: 1, lastSyncedAt: null, syncError: null }],
} as unknown as PeersOverview;
const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  branch: 'dev', detached: false, upstream: 'origin/dev', ahead: 1, behind: 0,
  files: [
    { path: 'a.ts', index: ' ', worktree: 'M' },
    { path: 'b.ts', index: '?', worktree: '?' },
  ],
  ...over,
});
const msg = (id: string, parts: Part[]): CanonMessage => ({
  id, chatId: 'c1', parentId: null, role: 'assistant', parts, status: 'complete', error: null, producedBy: null, createdAt: 1,
});
const edited: CanonMessage[] = [
  msg('m1', [
    { type: 'tool-call', id: 't1', name: 'Edit', args: { file_path: 'E:\\Git\\OtherBench\\src\\a.ts', old_string: 'before', new_string: 'after' } },
    { type: 'tool-result', id: 't1', name: 'Edit', result: 'ok', isError: false },
  ]),
];

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ apps: [app], appsLoaded: true, chats: [chat()], machines });
  vi.mocked(api.apps.git.status).mockResolvedValue(status());
  vi.mocked(api.apps.git.diff).mockResolvedValue({ diff: '' });
  vi.mocked(api.apps.git.branches).mockResolvedValue({ branches: [{ name: 'dev', current: true }] });
  vi.mocked(api.apps.git.commit).mockResolvedValue({ sha: 'abc' });
  vi.mocked(api.apps.git.pull).mockResolvedValue({ output: '' });
  vi.mocked(api.apps.git.push).mockResolvedValue({ output: '' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GitBar', () => {
  it('shows the app, the branch, the changed count and ahead/behind', async () => {
    render(<GitBar chat={chat()} messages={[]} />);
    const bar = screen.getByTestId('git-bar');
    expect(within(bar).getByText('OtherBench')).toBeInTheDocument();
    expect(await screen.findByTestId('git-branch')).toHaveTextContent('dev');
    expect(screen.getByTestId('git-changed-count')).toHaveTextContent('2 changed');
    expect(screen.getByTestId('git-ahead-behind')).toHaveTextContent('↑1');
    expect(screen.getByTestId('git-ahead-behind')).toHaveTextContent('↓0');
    expect(api.apps.git.status).toHaveBeenCalledWith('a1');
  });

  it('hides ahead/behind with no upstream', async () => {
    vi.mocked(api.apps.git.status).mockResolvedValue(status({ upstream: null, ahead: 0 }));
    render(<GitBar chat={chat()} messages={[]} />);
    expect(await screen.findByTestId('git-branch')).toHaveTextContent('dev');
    expect(screen.queryByTestId('git-ahead-behind')).toBeNull();
    expect(screen.queryByText(/↑/)).toBeNull();
  });

  it.each([
    ['not-a-repo', 'Not a git repository'],
    ['not-on-this-machine', "This app's folder isn't on this machine"],
    ['git-missing', "git isn't installed on this machine"],
  ])('a %s status says "%s"', async (code, copy) => {
    vi.mocked(api.apps.git.status).mockRejectedValue(new ApiError(409, 'server words', undefined, { code }));
    render(<GitBar chat={chat()} messages={[]} />);
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByText('server words')).toBeNull();
    expect(screen.queryByTestId('git-branch')).toBeNull();
  });

  it('refreshes on the button, on focus and after a turn in one of the app\'s chats', async () => {
    const user = userEvent.setup();
    render(<GitBar chat={chat()} messages={[]} />);
    await screen.findByTestId('git-branch');
    expect(api.apps.git.status).toHaveBeenCalledTimes(1);
    vi.mocked(api.apps.git.status).mockResolvedValue(status({ branch: 'main' }));
    await user.click(screen.getByRole('button', { name: 'Refresh git status' }));
    await waitFor(() => expect(screen.getByTestId('git-branch')).toHaveTextContent('main'));
    expect(api.apps.git.status).toHaveBeenCalledTimes(2);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(api.apps.git.status).toHaveBeenCalledTimes(3));
    act(() => {
      useOtherBenchStore.setState({ lastTurnFinished: { chatId: 'c1', messageId: 'm9' } });
    });
    await waitFor(() => expect(api.apps.git.status).toHaveBeenCalledTimes(4));
  });

  it('a chat that runs on another machine says so, and the git panel is read-only', async () => {
    const user = userEvent.setup();
    render(<GitBar chat={chat({ runsOn: 'node-pc' })} messages={[]} />);
    expect(screen.getByText("Runs on PC: git shows this machine's copy")).toBeInTheDocument();
    await user.click(await screen.findByTestId('git-branch'));
    const panel = await screen.findByRole('dialog', { name: 'Git' });
    // With a message typed, so only the machine keeps Commit off.
    await user.type(within(panel).getByRole('textbox', { name: 'Commit message' }), 'msg');
    expect(within(panel).getByRole('button', { name: 'Commit' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Pull' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Push' })).toBeDisabled();
  });

  it("while this window doesn't know its machine yet, the panel is read-only", async () => {
    const user = userEvent.setup();
    useOtherBenchStore.setState({ machines: null });
    render(<GitBar chat={chat()} messages={[]} />);
    expect(screen.queryByText(/Runs on/)).toBeNull();
    await user.click(await screen.findByTestId('git-branch'));
    const panel = await screen.findByRole('dialog', { name: 'Git' });
    await user.type(within(panel).getByRole('textbox', { name: 'Commit message' }), 'msg');
    expect(within(panel).getByRole('button', { name: 'Commit' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Pull' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Push' })).toBeDisabled();
  });

  it("a git-failed status shows git's stderr as-is", async () => {
    vi.mocked(api.apps.git.status).mockRejectedValue(new ApiError(409, 'fatal: bad object HEAD', undefined, { code: 'git-failed', stderr: 'fatal: bad object HEAD\nhint: run git fsck' }));
    render(<GitBar chat={chat()} messages={[]} />);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('fatal: bad object HEAD', { selector: 'p' })).toBeInTheDocument();
    expect(alert.querySelector('pre')?.textContent).toBe('fatal: bad object HEAD\nhint: run git fsck');
  });

  it("a failed push's stderr stays on screen even when the refresh after it fails too", async () => {
    const user = userEvent.setup();
    vi.mocked(api.apps.git.push).mockRejectedValue(new ApiError(409, 'push failed', undefined, { code: 'git-failed', stderr: ' ! [rejected] dev -> dev (fetch first)' }));
    render(<GitBar chat={chat()} messages={[]} />);
    await user.click(await screen.findByTestId('git-branch'));
    const panel = await screen.findByRole('dialog', { name: 'Git' });
    vi.mocked(api.apps.git.status).mockRejectedValue(new ApiError(409, 'gone', undefined, { code: 'not-a-repo' }));
    await user.click(within(panel).getByRole('button', { name: 'Push' }));
    await waitFor(() => expect(api.apps.git.status).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(' ! [rejected] dev -> dev (fetch first)', { normalizer: (s) => s })).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Git' })).toBeInTheDocument();
  });

  it('a press outside does not close the panel while an action runs', async () => {
    const user = userEvent.setup();
    let finish!: (v: { output: string }) => void;
    vi.mocked(api.apps.git.pull).mockReturnValue(new Promise((r) => (finish = r)));
    render(
      <>
        <GitBar chat={chat()} messages={[]} />
        <button type="button">elsewhere</button>
      </>
    );
    await user.click(await screen.findByTestId('git-branch'));
    await user.click(within(await screen.findByRole('dialog', { name: 'Git' })).getByRole('button', { name: 'Pull' }));
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.getByRole('dialog', { name: 'Git' })).toBeInTheDocument();
    await act(async () => finish({ output: 'done' }));
    expect(await screen.findByText('done')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('dialog', { name: 'Git' })).toBeNull();
  });

  it('a chat on this machine has no "Runs on" line and an enabled panel', async () => {
    const user = userEvent.setup();
    render(<GitBar chat={chat()} messages={[]} />);
    expect(screen.queryByText(/Runs on/)).toBeNull();
    await user.click(await screen.findByTestId('git-branch'));
    const panel = await screen.findByRole('dialog', { name: 'Git' });
    expect(within(panel).getByRole('button', { name: 'Pull' })).toBeEnabled();
    expect(screen.getByTestId('git-branch')).toHaveAttribute('aria-expanded', 'true');
  });

  it('the panel refetches the status after an action', async () => {
    const user = userEvent.setup();
    render(<GitBar chat={chat()} messages={[]} />);
    await user.click(await screen.findByTestId('git-branch'));
    await user.click(within(await screen.findByRole('dialog', { name: 'Git' })).getByRole('button', { name: 'Pull' }));
    await waitFor(() => expect(api.apps.git.status).toHaveBeenCalledTimes(2));
  });

  it('lists the files changed in this chat, their edits, and opens one in Files', async () => {
    const user = userEvent.setup();
    render(<GitBar chat={chat()} messages={edited} />);
    const pill = screen.getByTestId('changed-in-chat');
    expect(pill).toHaveTextContent('1 file changed in this chat');
    await user.click(pill);
    const list = screen.getByRole('dialog', { name: 'Changed in this chat' });
    const row = within(list).getByRole('button', { name: /src\/a\.ts/ });
    expect(row).toHaveTextContent('+1');
    expect(row).toHaveTextContent('−1');
    await user.click(row);
    expect(within(list).getByTestId('edit-diff')).toHaveTextContent('after');
    await user.click(within(list).getByRole('button', { name: 'Open in Files' }));
    expect(useOtherBenchStore.getState().codePanelTab).toBe('files');
    expect(viewerActionsFor).toHaveBeenCalledWith('c1');
    expect(openPath).toHaveBeenCalledWith('src/a.ts');
  });

  it('hides the pill when the chat has changed nothing', async () => {
    render(<GitBar chat={chat()} messages={[]} />);
    await screen.findByTestId('git-branch');
    expect(screen.queryByTestId('changed-in-chat')).toBeNull();
  });
});
