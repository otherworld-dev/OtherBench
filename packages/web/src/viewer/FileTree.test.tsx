import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../desktop/bridge.js', () => ({ isDesktop: vi.fn(() => true), openFolder: vi.fn(async () => true), revealPath: vi.fn(async () => true) }));

import { isDesktop, openFolder, revealPath } from '../desktop/bridge.js';
import { DirTree, type LoadDir } from './FileTree.js';

const loadDir: LoadDir = async (path) =>
  path === undefined
    ? { path: 'C:\\repo', entries: [{ name: 'src', path: 'C:\\repo\\src', type: 'dir' }, { name: 'tool.exe', path: 'C:\\repo\\tool.exe', type: 'file' }] }
    : { path, entries: [] };

beforeEach(() => {
  vi.mocked(isDesktop).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DirTree right-click menu', () => {
  it('opens a folder in the file manager, including the root, without expanding it', async () => {
    const user = userEvent.setup();
    render(<DirTree label="repo" loadDir={loadDir} onOpen={vi.fn()} />);
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'src' }));
    await user.click(screen.getByRole('menuitem', { name: /^Open in / }));
    expect(openFolder).toHaveBeenCalledWith('C:\\repo\\src');
    expect(screen.getByRole('treeitem', { name: 'src' })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'repo' }));
    await user.click(screen.getByRole('menuitem', { name: /^Open in / }));
    expect(openFolder).toHaveBeenLastCalledWith('C:\\repo');
  });

  it('shows a file in its folder, never opening it', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<DirTree label="repo" loadDir={loadDir} onOpen={onOpen} />);
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'tool.exe' }));
    expect(screen.queryByRole('menuitem', { name: /^Open in / })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: /^Show in / }));
    expect(revealPath).toHaveBeenCalledWith('C:\\repo\\tool.exe');
    expect(openFolder).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('copies the path, and opens from the keyboard with Shift+F10', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<DirTree label="repo" loadDir={loadDir} onOpen={vi.fn()} />);
    (await screen.findByRole('button', { name: 'src' })).focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    await user.click(screen.getByRole('menuitem', { name: 'Copy path' }));
    expect(writeText).toHaveBeenCalledWith('C:\\repo\\src');
  });

  it('in a browser offers only Copy path', async () => {
    vi.mocked(isDesktop).mockReturnValue(false);
    render(<DirTree label="repo" loadDir={loadDir} onOpen={vi.fn()} />);
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'src' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Copy path']);
  });

  it('says so when the shell fails', async () => {
    const user = userEvent.setup();
    vi.mocked(openFolder).mockRejectedValueOnce(new Error('gone'));
    render(<DirTree label="repo" loadDir={loadDir} onOpen={vi.fn()} />);
    fireEvent.contextMenu(await screen.findByRole('button', { name: 'src' }));
    await user.click(screen.getByRole('menuitem', { name: /^Open in / }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't open this folder/);
  });
});
