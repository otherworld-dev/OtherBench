import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: {
      health: vi.fn(),
      node: { get: vi.fn() },
      projects: { list: vi.fn() },
      locations: { list: vi.fn(), create: vi.fn(), rename: vi.fn(), setPath: vi.fn(), delete: vi.fn() },
    },
  };
});

import { api, type LocationView } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';
import { LOCATIONS_HELP, LocationsPanel } from './LocationsPanel.js';

const nextcloud: LocationView = {
  id: 'nc',
  name: 'Nextcloud',
  paths: [
    { locationId: 'nc', nodeId: 'node-pc', path: 'E:\\Nextcloud' },
    { locationId: 'nc', nodeId: 'node-laptop-1234', path: 'C:\\Users\\Adam\\Nextcloud' },
  ],
};
const git: LocationView = { id: 'git', name: 'Git', paths: [{ locationId: 'git', nodeId: 'node-laptop-1234', path: 'C:\\Git' }] };

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  vi.mocked(api.health).mockReset().mockResolvedValue({ status: 'ok', time: '', platform: 'win32' });
  vi.mocked(api.node.get).mockReset().mockResolvedValue({ id: 'node-pc', name: 'PC' });
  vi.mocked(api.projects.list).mockReset().mockResolvedValue([]);
  vi.mocked(api.locations.list).mockReset().mockResolvedValue([git, nextcloud]);
  vi.mocked(api.locations.create).mockReset();
  vi.mocked(api.locations.rename).mockReset();
  vi.mocked(api.locations.setPath).mockReset();
  vi.mocked(api.locations.delete).mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('LocationsPanel', () => {
  it("lists each location with this machine's path, or not set here, and other machines' paths read-only", async () => {
    render(<LocationsPanel />);
    const nc = await screen.findByTestId('location-nc');
    expect(screen.getByText(LOCATIONS_HELP)).toBeInTheDocument();
    expect(within(nc).getByText('E:\\Nextcloud')).toBeInTheDocument();
    expect(within(nc).getByText(/Another machine \(node-lap\)/)).toBeInTheDocument();
    expect(within(nc).getByText('C:\\Users\\Adam\\Nextcloud')).toBeInTheDocument();
    const g = screen.getByTestId('location-git');
    expect(within(g).getByText('not set here')).toBeInTheDocument();
    expect(within(g).getByRole('button', { name: 'Set' })).toBeInTheDocument();
  });

  it("reloads when another machine's changes arrive", async () => {
    render(<LocationsPanel />);
    await screen.findByTestId('location-nc');
    expect(api.locations.list).toHaveBeenCalledTimes(1);
    useGruntStore.setState({ syncRevision: 1 });
    await waitFor(() => expect(api.locations.list).toHaveBeenCalledTimes(2));
  });

  it('adds a location with a path here, checking the path first', async () => {
    vi.mocked(api.locations.create).mockResolvedValue({ id: 'docs', name: 'Docs', paths: [{ locationId: 'docs', nodeId: 'node-pc', path: 'E:\\Docs' }] });
    render(<LocationsPanel />);
    await screen.findByTestId('location-nc');

    await userEvent.type(screen.getByRole('textbox', { name: 'New location name' }), 'Docs');
    await userEvent.type(screen.getByRole('textbox', { name: 'New location folder on this machine' }), 'docs');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Windows path');
    expect(api.locations.create).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByRole('textbox', { name: 'New location folder on this machine' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'New location folder on this machine' }), 'E:\\Docs');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.locations.create).toHaveBeenCalledWith({ name: 'Docs', path: 'E:\\Docs' }));
    expect(await screen.findByTestId('location-docs')).toBeInTheDocument();
  });

  it("sets and removes this machine's path, renames, and deletes after confirming", async () => {
    vi.mocked(api.locations.setPath).mockImplementation(async (id, path) => ({ ...git, paths: path ? [...git.paths, { locationId: id, nodeId: 'node-pc', path }] : git.paths }));
    vi.mocked(api.locations.rename).mockImplementation(async (_id, name) => ({ ...git, name }));
    render(<LocationsPanel />);
    const g = await screen.findByTestId('location-git');

    await userEvent.click(within(g).getByRole('button', { name: 'Set' }));
    await userEvent.type(within(g).getByRole('textbox', { name: 'Git folder on this machine' }), 'E:\\Git');
    await userEvent.click(within(g).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.locations.setPath).toHaveBeenCalledWith('git', 'E:\\Git'));
    expect(await within(g).findByText('E:\\Git')).toBeInTheDocument();
    expect(api.projects.list).toHaveBeenCalled();

    await userEvent.click(within(g).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.locations.setPath).toHaveBeenCalledWith('git', null));

    await userEvent.click(within(g).getByRole('button', { name: 'Rename' }));
    await userEvent.clear(within(g).getByRole('textbox', { name: 'Location name' }));
    await userEvent.type(within(g).getByRole('textbox', { name: 'Location name' }), 'Code');
    await userEvent.click(within(g).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.locations.rename).toHaveBeenCalledWith('git', 'Code'));

    await userEvent.click(within(screen.getByTestId('location-git')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete location' }));
    await waitFor(() => expect(api.locations.delete).toHaveBeenCalledWith('git'));
    await waitFor(() => expect(screen.queryByTestId('location-git')).toBeNull());
  });
});
