import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@otherbench/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, apps: { ...actual.api.apps, files: vi.fn(), text: vi.fn() }, view: { ...actual.api.view, dir: vi.fn(), text: vi.fn() } } };
});

import { ApiError, api } from '../state/api.js';
import { useViewerStore } from '../viewer/state.js';
import { FilesTab } from './FilesTab.js';

const app: App = { id: 'a1', name: 'OtherBench', workspace: null, workspaceRoot: '/repo', githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };

beforeEach(() => {
  window.localStorage.clear();
  useViewerStore.setState({ viewers: {} });
  vi.mocked(api.apps.files).mockImplementation(async (_id, path) =>
    path === undefined
      ? { path: '/repo', entries: [{ name: 'src', path: '/repo/src', type: 'dir' }, { name: 'README.md', path: '/repo/README.md', type: 'file' }] }
      : { path, entries: [{ name: 'main.ts', path: `${path}/main.ts`, type: 'file' }] }
  );
  vi.mocked(api.apps.text).mockResolvedValue({ path: '/repo/README.md', content: '# Hello', truncated: false, size: 7 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FilesTab', () => {
  it("lists the app's root through the app's own files route, and a folder's entries when it opens", async () => {
    const user = userEvent.setup();
    render(<FilesTab app={app} chatId={null} />);
    expect(await screen.findByRole('button', { name: 'README.md' })).toBeInTheDocument();
    expect(api.apps.files).toHaveBeenCalledWith('a1', undefined);
    expect(api.view.dir).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'src' }));
    expect(await screen.findByRole('button', { name: 'main.ts' })).toBeInTheDocument();
    expect(api.apps.files).toHaveBeenCalledWith('a1', '/repo/src');
  });

  it('with no app chat focused, a file opens read-only in the panel', async () => {
    const user = userEvent.setup();
    render(<FilesTab app={app} chatId={null} />);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    const view = await screen.findByTestId('files-readonly');
    expect(api.apps.text).toHaveBeenCalledWith('a1', '/repo/README.md');
    expect(within(view).getByText('# Hello')).toBeInTheDocument();
    expect(within(view).getByText('README.md')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to files' }));
    expect(await screen.findByRole('button', { name: 'README.md' })).toBeInTheDocument();
  });

  it("with an app chat focused, a file opens in that chat's viewer", async () => {
    const user = userEvent.setup();
    render(<FilesTab app={app} chatId="c1" />);
    await user.click(await screen.findByRole('button', { name: 'README.md' }));
    const viewer = useViewerStore.getState().viewers['c1'];
    expect(viewer?.open).toBe(true);
    expect(viewer?.history.at(-1)).toEqual({ kind: 'file', path: '/repo/README.md' });
    expect(api.apps.text).not.toHaveBeenCalled();
  });

  it("a folder that isn't on this machine says so", async () => {
    vi.mocked(api.apps.files).mockRejectedValue(new ApiError(409, 'This app has no folder.', undefined, { code: 'not-on-this-machine' }));
    render(<FilesTab app={app} chatId={null} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("This app's folder isn't on this machine"));
  });
});
