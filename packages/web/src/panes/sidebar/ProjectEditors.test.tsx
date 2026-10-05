import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return { ...actual, api: { ...actual.api, health: vi.fn() } };
});

import { ApiError, api } from '../../state/api.js';
import { ProjectFolderEditor, ProjectProfileEditor } from './ProjectEditors.js';

const project: Project = { id: 'p-a', name: 'Alpha', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };

function profile(id: string, name: string, archivedAt: number | null = null): Profile {
  return { id, name, description: null, colour: null, connectionId: 'c', modelId: 'm', systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt };
}

beforeEach(() => {
  vi.mocked(api.health).mockResolvedValue({ status: 'ok', time: '', platform: 'linux' });
});

afterEach(cleanup);

describe('ProjectFolderEditor', () => {
  it('validates like the Inspector before saving, then saves the trimmed path', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(<ProjectFolderEditor project={project} onSave={onSave} onCancel={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Project folder' });
    await waitFor(() => expect(api.health).toHaveBeenCalled());

    await user.type(input, 'relative/path');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // (the exact wording depends on whether the platform has loaded yet; both say this)
    expect(screen.getByTestId('project-folder-error')).toHaveTextContent(/native absolute path/);
    expect(onSave).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, '  /home/me/alpha  {Enter}');
    expect(onSave).toHaveBeenCalledWith('/home/me/alpha');
  });

  it("shows the server's message when the save fails, and stays open", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {
      throw new ApiError(400, '"workspaceRoot" must be a native absolute path');
    });
    render(<ProjectFolderEditor project={project} onSave={onSave} onCancel={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Project folder' }), '/srv/x');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByTestId('project-folder-error')).toHaveTextContent('"workspaceRoot" must be a native absolute path');
    expect(screen.getByRole('textbox', { name: 'Project folder' })).toBeInTheDocument();
  });

  it('offers Clear only when a folder is set, and Clear saves null; Escape cancels', async () => {
    const user = userEvent.setup();
    expect(render(<ProjectFolderEditor project={project} onSave={vi.fn(async () => {})} onCancel={vi.fn()} />).queryByRole('button', { name: 'Clear' })).toBeNull();
    cleanup();

    const onSave = vi.fn(async () => {});
    const onCancel = vi.fn();
    render(<ProjectFolderEditor project={{ ...project, workspaceRoot: '/srv/old' }} onSave={onSave} onCancel={onCancel} />);
    expect(screen.getByRole('textbox', { name: 'Project folder' })).toHaveValue('/srv/old');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onSave).toHaveBeenCalledWith(null);
    screen.getByRole('textbox', { name: 'Project folder' }).focus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('ProjectProfileEditor', () => {
  const profiles = [profile('p1', 'Everyday'), profile('p2', 'Coder'), profile('p-old', 'Old', 9)];

  it('offers App default plus every unarchived profile, preselecting the current default', () => {
    render(<ProjectProfileEditor project={{ ...project, defaultProfileId: 'p2' }} profiles={profiles} onSave={vi.fn(async () => {})} onCancel={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: 'Default profile' });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['App default', 'Everyday', 'Coder']);
    expect(select).toHaveValue('p2');
  });

  it('shows an archived current default as App default', () => {
    render(<ProjectProfileEditor project={{ ...project, defaultProfileId: 'p-old' }} profiles={profiles} onSave={vi.fn(async () => {})} onCancel={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Default profile' })).toHaveValue('');
  });

  it('Save sends the chosen id, or null for App default', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    render(<ProjectProfileEditor project={project} profiles={profiles} onSave={onSave} onCancel={vi.fn()} />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Default profile' }), 'p1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenLastCalledWith('p1');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Default profile' }), '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenLastCalledWith(null);
  });
});
