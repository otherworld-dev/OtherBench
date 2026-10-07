import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../desktop/bridge.js', () => ({ pickFolder: vi.fn(async () => '/home/me/picked') }));
vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return { ...actual, api: { ...actual.api, health: vi.fn(async () => ({ status: 'ok', time: '', platform: 'linux' })) } };
});

import type { DraftFolder } from './draft.js';
import { FolderDraftList } from './FolderDraftList.js';

afterEach(cleanup);

const notes: DraftFolder = { entry: { path: '/home/me/notes', access: 'read' }, display: '/home/me/notes' };

describe('FolderDraftList', () => {
  it('adds a valid path with the chosen access, without saving anything itself', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FolderDraftList folders={[]} onChange={onChange} canPick={false} />);

    expect(screen.getByText('None.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Folder path to add' }), '/home/me/notes');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Access to the new folder' }), 'readwrite');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(onChange).toHaveBeenCalledWith([{ entry: { path: '/home/me/notes', access: 'readwrite' }, display: '/home/me/notes' }]);
    expect(screen.getByRole('textbox', { name: 'Folder path to add' })).toHaveValue('');
  });

  it('refuses a relative path and a folder already listed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FolderDraftList folders={[notes]} onChange={onChange} canPick={false} />);

    await user.type(screen.getByRole('textbox', { name: 'Folder path to add' }), 'relative{Enter}');
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.clear(screen.getByRole('textbox', { name: 'Folder path to add' }));
    await user.type(screen.getByRole('textbox', { name: 'Folder path to add' }), '/home/me/notes{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('That folder is already in the list.');
    expect(onChange).not.toHaveBeenCalled();
  });

  it("changes a folder's access and removes a folder", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FolderDraftList folders={[notes]} onChange={onChange} canPick={false} />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Access to /home/me/notes' }), 'readwrite');
    expect(onChange).toHaveBeenLastCalledWith([{ entry: { path: '/home/me/notes', access: 'readwrite' }, display: '/home/me/notes' }]);

    await user.click(screen.getByRole('button', { name: 'Remove /home/me/notes' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('offers Choose… only when it can pick, and adds the picked folder', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<FolderDraftList folders={[]} onChange={onChange} canPick={false} />);
    expect(screen.queryByRole('button', { name: 'Choose…' })).toBeNull();

    rerender(<FolderDraftList folders={[]} onChange={onChange} canPick />);
    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith([{ entry: { path: '/home/me/picked', access: 'read' }, display: '/home/me/picked' }]));
  });
});
