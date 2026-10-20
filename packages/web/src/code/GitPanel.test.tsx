import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@otherbench/core/ports/store.js';
import type { GitStatus } from '@otherbench/core/types/code.js';

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

import { ApiError, api } from '../state/api.js';
import { GitPanel } from './GitPanel.js';

const app: App = {
  id: 'a1', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1,
};
const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  branch: 'dev', detached: false, upstream: 'origin/dev', ahead: 1, behind: 0,
  files: [
    { path: 'a.ts', index: ' ', worktree: 'M' },
    { path: 'b.ts', index: '?', worktree: '?' },
  ],
  ...over,
});
const DIFF = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1 +1 @@',
  '-old line',
  '+new line',
  'diff --git a/b.ts b/b.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/b.ts',
  '@@ -0,0 +1 @@',
  '+fresh',
  '',
].join('\n');

const onChanged = vi.fn();
const onClose = vi.fn();
function renderPanel(over: { status?: GitStatus; readOnly?: boolean } = {}) {
  return render(<GitPanel app={app} status={over.status ?? status()} readOnly={over.readOnly ?? false} onChanged={onChanged} onClose={onClose} />);
}

beforeEach(() => {
  vi.mocked(api.apps.git.diff).mockResolvedValue({ diff: DIFF });
  vi.mocked(api.apps.git.branches).mockResolvedValue({ branches: [{ name: 'dev', current: true }, { name: 'main', current: false }] });
  vi.mocked(api.apps.git.commit).mockResolvedValue({ sha: 'abc123' });
  vi.mocked(api.apps.git.pull).mockResolvedValue({ output: 'Already up to date.' });
  vi.mocked(api.apps.git.push).mockResolvedValue({ output: '' });
  vi.mocked(api.apps.git.checkout).mockResolvedValue(undefined);
  vi.mocked(api.apps.git.branch).mockResolvedValue(undefined);
  onChanged.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GitPanel', () => {
  it('lists the changed files, all checked, each with its git diff', async () => {
    renderPanel();
    const a = screen.getByRole('checkbox', { name: 'a.ts' });
    const b = screen.getByRole('checkbox', { name: 'b.ts' });
    expect(a).toBeChecked();
    expect(b).toBeChecked();
    expect(await screen.findByText('new line')).toBeInTheDocument();
    expect(screen.getByText('old line')).toBeInTheDocument();
    expect(screen.getByText('fresh')).toBeInTheDocument();
    expect(api.apps.git.diff).toHaveBeenCalledWith('a1');
  });

  it("commits only the checked files when one is unchecked, then refreshes", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('checkbox', { name: 'b.ts' }));
    await user.type(screen.getByRole('textbox', { name: 'Commit message' }), 'msg');
    await user.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(api.apps.git.commit).toHaveBeenCalledWith('a1', { message: 'msg', paths: ['a.ts'] }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue('');
  });

  it("sends 'all' when every file is checked", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(screen.getByRole('textbox', { name: 'Commit message' }), 'msg');
    await user.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(api.apps.git.commit).toHaveBeenCalledWith('a1', { message: 'msg', paths: 'all' }));
  });

  it('Commit needs a message and at least one file', async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Commit message' }), 'msg');
    expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: 'a.ts' }));
    await user.click(screen.getByRole('checkbox', { name: 'b.ts' }));
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
  });

  it("a failed push shows git's stderr as-is", async () => {
    const user = userEvent.setup();
    vi.mocked(api.apps.git.push).mockRejectedValue(
      new ApiError(409, 'error: failed to push some refs', undefined, { code: 'git-failed', stderr: ' ! [rejected]        dev -> dev (fetch first)\nerror: failed to push some refs' })
    );
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Push' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('error: failed to push some refs', { selector: 'p' })).toBeInTheDocument();
    const pre = alert.querySelector('pre');
    expect(pre?.textContent).toBe(' ! [rejected]        dev -> dev (fetch first)\nerror: failed to push some refs');
    expect(pre).toBeVisible();
  });

  it('with no upstream, Push reads "Push and set upstream" and sets it', async () => {
    const user = userEvent.setup();
    renderPanel({ status: status({ upstream: null, ahead: 0 }) });
    await user.click(screen.getByRole('button', { name: 'Push and set upstream' }));
    await waitFor(() => expect(api.apps.git.push).toHaveBeenCalledWith('a1', { setUpstream: true }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('pulls, shows the output and refreshes', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Pull' }));
    expect(await screen.findByText('Already up to date.')).toBeInTheDocument();
    expect(api.apps.git.pull).toHaveBeenCalledWith('a1');
    expect(onChanged).toHaveBeenCalled();
  });

  it('switches branch from the picker and creates a new one', async () => {
    const user = userEvent.setup();
    const { rerender } = renderPanel();
    const picker = screen.getByRole('combobox', { name: 'Branch' });
    await screen.findByRole('option', { name: 'main' });
    expect(picker).toHaveValue('dev');
    await user.selectOptions(picker, 'main');
    await waitFor(() => expect(api.apps.git.checkout).toHaveBeenCalledWith('a1', 'main'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // The refreshed status the bar passes back in brings the branch list and the diff up to date.
    expect(api.apps.git.branches).toHaveBeenCalledTimes(1);
    rerender(<GitPanel app={app} status={status({ branch: 'main' })} readOnly={false} onChanged={onChanged} onClose={onClose} />);
    await waitFor(() => expect(api.apps.git.branches).toHaveBeenCalledTimes(2));
    expect(api.apps.git.diff).toHaveBeenCalledTimes(2);
    expect(picker).toHaveValue('main');

    await user.type(screen.getByRole('textbox', { name: 'New branch' }), 'feat/x');
    await user.click(screen.getByRole('button', { name: 'Create branch' }));
    await waitFor(() => expect(api.apps.git.branch).toHaveBeenCalledWith('a1', 'feat/x'));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'New branch' })).toHaveValue(''));
  });

  it('read-only (the chat runs elsewhere): Commit, Pull, Push and the branch controls are off', async () => {
    const user = userEvent.setup();
    renderPanel({ readOnly: true });
    await user.type(screen.getByRole('textbox', { name: 'Commit message' }), 'msg');
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pull' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Push' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Branch' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'New branch' })).toBeDisabled();
    // Status and diffs still show.
    expect(await screen.findByText('new line')).toBeInTheDocument();
  });

  it('Escape and the close button close it', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Close git panel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    screen.getByRole('dialog', { name: 'Git' }).focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("a new folder's row shows the diff of every file under it", async () => {
    vi.mocked(api.apps.git.diff).mockResolvedValue({
      diff: [
        'diff --git a/newdir/a.ts b/newdir/a.ts', 'new file mode 100644', '--- /dev/null', '+++ b/newdir/a.ts', '@@ -0,0 +1 @@', '+first',
        'diff --git a/newdir/sub/b.ts b/newdir/sub/b.ts', 'new file mode 100644', '--- /dev/null', '+++ b/newdir/sub/b.ts', '@@ -0,0 +1 @@', '+second',
        'diff --git a/newdirx.ts b/newdirx.ts', '--- /dev/null', '+++ b/newdirx.ts', '@@ -0,0 +1 @@', '+not under it',
        '',
      ].join('\n'),
    });
    renderPanel({ status: status({ files: [{ path: 'newdir/', index: '?', worktree: '?' }] }) });
    const row = screen.getByRole('checkbox', { name: 'newdir/' }).closest('li')!;
    expect(await within(row).findByText('first')).toBeInTheDocument();
    expect(within(row).getByText('second')).toBeInTheDocument();
    expect(within(row).getAllByTestId('edit-diff')).toHaveLength(2);
    expect(screen.queryByText('not under it')).toBeNull();
  });

  it('an untracked file shows as a new file', async () => {
    renderPanel();
    const row = screen.getByRole('checkbox', { name: 'b.ts' }).closest('li')!;
    expect(await within(row).findByTestId('edit-diff')).toHaveTextContent('wrote');
    const tracked = screen.getByRole('checkbox', { name: 'a.ts' }).closest('li')!;
    expect(within(tracked).getByTestId('edit-diff')).not.toHaveTextContent('wrote');
  });

  it('a partial commit of a renamed file sends its old path too', async () => {
    const user = userEvent.setup();
    renderPanel({
      status: status({
        files: [
          { path: 'new.ts', origPath: 'old.ts', index: 'R', worktree: ' ' },
          { path: 'b.ts', index: '?', worktree: '?' },
        ],
      }),
    });
    await user.click(screen.getByRole('checkbox', { name: 'b.ts' }));
    await user.type(screen.getByRole('textbox', { name: 'Commit message' }), 'msg');
    await user.click(screen.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(api.apps.git.commit).toHaveBeenCalledWith('a1', { message: 'msg', paths: ['old.ts', 'new.ts'] }));
  });

  it('read-only refuses an action even when the control is driven directly', async () => {
    renderPanel({ readOnly: true });
    await screen.findByRole('option', { name: 'main' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Branch' }), { target: { value: 'main' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(api.apps.git.checkout).not.toHaveBeenCalled();
  });

  it('one action at a time: a second request while one runs is ignored', async () => {
    let finish!: (v: { output: string }) => void;
    vi.mocked(api.apps.git.pull).mockReturnValue(new Promise((r) => (finish = r)));
    renderPanel();
    await screen.findByRole('option', { name: 'main' });
    const input = screen.getByRole('textbox', { name: 'New branch' });
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pull' }));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.apps.git.branch).not.toHaveBeenCalled();
    finish({ output: 'ok' });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('a clean tree says so', () => {
    renderPanel({ status: status({ files: [] }) });
    expect(screen.getByText('No changes')).toBeInTheDocument();
  });
});
