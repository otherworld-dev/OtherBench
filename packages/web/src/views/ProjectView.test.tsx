import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';

vi.mock('../desktop/bridge.js', () => ({ isDesktop: () => false, pickFolder: vi.fn() }));
vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      projects: { ...actual.api.projects, create: vi.fn(), patch: vi.fn() },
      health: vi.fn(async () => ({ status: 'ok', time: '', platform: 'linux' })),
    },
  };
});

import { ApiError, api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { ProjectView } from './ProjectView.js';

const profile: Profile = {
  id: 'profile-1',
  name: 'Everyday',
  description: null,
  colour: null,
  connectionId: 'conn-1',
  modelId: 'm',
  systemPrompt: null,
  params: {},
  toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
  isDefault: true,
  archivedAt: null,
};

function project(over: Partial<Project> & { id: string }): Project {
  return { name: over.id, description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ profiles: [profile] });
  vi.mocked(api.projects.create).mockReset();
  vi.mocked(api.projects.patch).mockReset();
});
afterEach(cleanup);

describe('ProjectView, creating', () => {
  it('creates the project with everything on the page in one request, then closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(api.projects.create).mockResolvedValue(project({ id: 'p-new', name: 'Grunt' }));
    render(<ProjectView page={{ mode: 'create' }} onClose={onClose} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), ' Grunt ');
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Local workbench');
    await user.type(screen.getByRole('textbox', { name: 'Instructions' }), 'British English.');
    await user.type(screen.getByRole('textbox', { name: 'Main folder' }), '/home/me/grunt');
    await user.type(screen.getByRole('textbox', { name: 'Folder path to add' }), '/home/me/notes');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Access to the new folder' }), 'readwrite');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Default profile' }), 'profile-1');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.projects.create).toHaveBeenCalledWith({
      name: 'Grunt',
      description: 'Local workbench',
      instructions: 'British English.',
      workspaceRoot: '/home/me/grunt',
      defaultProfileId: 'profile-1',
      folders: [{ path: '/home/me/notes', access: 'readwrite' }],
    });
    expect(useGruntStore.getState().projects.map((p) => p.id)).toContain('p-new');
  });

  it('asks for a name before sending anything', async () => {
    const user = userEvent.setup();
    render(<ProjectView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Create project' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give the project a name.');
    expect(api.projects.create).not.toHaveBeenCalled();
  });

  it("keeps the page and the draft open when the server refuses, showing the server's message", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    vi.mocked(api.projects.create).mockRejectedValue(new ApiError(400, '"folders[0].path" must be a folder\'s absolute path.'));
    render(<ProjectView page={{ mode: 'create' }} onClose={onClose} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Grunt');
    await user.type(screen.getByRole('textbox', { name: 'Instructions' }), 'Keep me.');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('"folders[0].path"');
    expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveValue('Keep me.');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a double click creates one project', async () => {
    const user = userEvent.setup();
    vi.mocked(api.projects.create).mockImplementation(() => new Promise(() => {}));
    render(<ProjectView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Grunt');
    await user.dblClick(screen.getByRole('button', { name: 'Create project' }));
    expect(api.projects.create).toHaveBeenCalledTimes(1);
  });

  it('counts the instructions, and over 8,000 characters turns the counter red and disables Create', () => {
    render(<ProjectView page={{ mode: 'create' }} onClose={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: 'Instructions' });

    fireEvent.change(box, { target: { value: 'x'.repeat(8_000) } });
    expect(screen.getByTestId('instructions-count')).toHaveTextContent('8,000 / 8,000');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();

    fireEvent.change(box, { target: { value: 'x'.repeat(8_001) } });
    expect(screen.getByTestId('instructions-count')).toHaveTextContent('8,001 / 8,000');
    expect(screen.getByTestId('instructions-count')).toHaveClass('text-[var(--danger)]');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
  });
});

describe('ProjectView, closing', () => {
  it('Esc closes a clean page at once, but asks before discarding changes; Esc in that question only closes the question', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = render(<ProjectView page={{ mode: 'create' }} onClose={onClose} />);
    await user.keyboard('{Escape}'); // focus starts on Name
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    onClose.mockClear();
    render(<ProjectView page={{ mode: 'create' }} onClose={onClose} />);
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Draft');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog', { name: 'Discard changes?' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog', { name: 'Discard changes?' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft');
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(within(screen.getByRole('alertdialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('gives focus back to what opened it', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    render(<ProjectView page={{ mode: 'create' }} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(opener).toHaveFocus());
    opener.remove();
  });
});

describe('ProjectView, editing', () => {
  it('opens filled in from the project and saves only what changed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    useGruntStore.setState({
      projects: [project({ id: 'p1', name: 'Alpha', description: 'Old', instructions: 'Be brief.', workspaceRoot: '/srv/alpha', defaultProfileId: 'profile-1' })],
    });
    vi.mocked(api.projects.patch).mockResolvedValue(project({ id: 'p1', name: 'Alpha', instructions: 'Be thorough.' }));
    render(<ProjectView page={{ mode: 'edit', projectId: 'p1' }} onClose={onClose} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Alpha');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Old');
    expect(screen.getByRole('textbox', { name: 'Main folder' })).toHaveValue('/srv/alpha');
    expect(screen.getByRole('combobox', { name: 'Default profile' })).toHaveValue('profile-1');

    const box = screen.getByRole('textbox', { name: 'Instructions' });
    await user.clear(box);
    await user.type(box, 'Be thorough.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.projects.patch).toHaveBeenCalledWith('p1', { instructions: 'Be thorough.' });
    expect(useGruntStore.getState().projects[0]!.instructions).toBe('Be thorough.');
  });

  it('Save with nothing changed sends nothing and closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    useGruntStore.setState({ projects: [project({ id: 'p1', name: 'Alpha' })] });
    render(<ProjectView page={{ mode: 'edit', projectId: 'p1' }} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.projects.patch).not.toHaveBeenCalled();
  });

  it('says so when the project is gone, with only Close', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ProjectView page={{ mode: 'edit', projectId: 'deleted' }} onClose={onClose} />);
    expect(screen.getByText(/This project no longer exists/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
