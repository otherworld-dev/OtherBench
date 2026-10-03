import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@grunt/core/types/config.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return { ...actual, api: { settings: { get: vi.fn(), patch: vi.fn() } } };
});

import { ApiError, api } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';
import { MEMORY_MODEL_HINT, ProjectsPanel } from './ProjectsPanel.js';

const mockedGet = vi.mocked(api.settings.get);
const mockedPatch = vi.mocked(api.settings.patch);

function profile(id: string, name: string, archivedAt: number | null = null): Profile {
  return {
    id,
    name,
    description: null,
    colour: null,
    connectionId: 'c',
    modelId: 'm',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt,
  };
}

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ profiles: [profile('p-cheap', 'Local Llama'), profile('p-big', 'Opus'), profile('p-old', 'Old', 5)] });
  mockedGet.mockReset().mockResolvedValue({ memoryProfileId: null });
  mockedPatch.mockReset().mockImplementation(async (body) => ({ memoryProfileId: body.memoryProfileId ?? null }));
});

afterEach(cleanup);

function select(): HTMLSelectElement {
  return screen.getByRole('combobox', { name: 'Memory model' }) as HTMLSelectElement;
}

describe('ProjectsPanel', () => {
  it('offers Project default plus every live profile, with a hint to pick a cheap or local model', async () => {
    render(<ProjectsPanel />);
    await waitFor(() => expect(select()).toBeEnabled());
    expect(Array.from(select().options).map((o) => o.textContent)).toEqual(['Project default', 'Local Llama', 'Opus']);
    expect(select().value).toBe('');
    expect(screen.getByText(MEMORY_MODEL_HINT)).toBeInTheDocument();
    expect(MEMORY_MODEL_HINT).toContain('cheap or local model');
  });

  it('shows the saved choice and saves a new one', async () => {
    mockedGet.mockResolvedValue({ memoryProfileId: 'p-big' });
    render(<ProjectsPanel />);
    await waitFor(() => expect(select().value).toBe('p-big'));

    await userEvent.setup().selectOptions(select(), 'p-cheap');

    expect(mockedPatch).toHaveBeenCalledWith({ memoryProfileId: 'p-cheap' });
    await waitFor(() => expect(select().value).toBe('p-cheap'));
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
  });

  it('choosing Project default saves null', async () => {
    mockedGet.mockResolvedValue({ memoryProfileId: 'p-big' });
    render(<ProjectsPanel />);
    await waitFor(() => expect(select().value).toBe('p-big'));
    await userEvent.setup().selectOptions(select(), '');
    expect(mockedPatch).toHaveBeenCalledWith({ memoryProfileId: null });
  });

  it("shows the server's message when saving fails, and a stored profile that is no longer live reads as Project default", async () => {
    mockedGet.mockResolvedValue({ memoryProfileId: 'p-old' });
    mockedPatch.mockRejectedValue(new ApiError(400, '"memoryProfileId": profile "Opus" is archived.'));
    render(<ProjectsPanel />);
    await waitFor(() => expect(select()).toBeEnabled());
    expect(select().value).toBe('');

    await userEvent.setup().selectOptions(select(), 'p-big');
    expect(await screen.findByRole('alert')).toHaveTextContent('"memoryProfileId": profile "Opus" is archived.');
  });
});
