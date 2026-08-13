import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, ModelInfo, Profile } from '@grunt/core/types/config.js';
import { useGruntStore } from '../../state/store.js';
import { ProfilesPanel } from './ProfilesPanel.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: {
      profiles: { list: vi.fn(), create: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
    },
  };
});

import { api } from '../../state/api.js';

const mockedCreate = vi.mocked(api.profiles.create);
const mockedPatch = vi.mocked(api.profiles.patch);
const mockedDelete = vi.mocked(api.profiles.delete);

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    name: 'Local Ollama',
    kind: 'ollama',
    baseUrl: null,
    secretRef: null,
    extraHeaders: {},
    status: 'ok',
    statusMessage: null,
    checkedAt: null,
    ...overrides,
  };
}

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'model-1',
    connectionId: 'conn-1',
    modelId: 'llama3.2',
    displayName: 'llama3.2',
    source: 'discovered',
    supportsVision: false,
    supportsTools: false,
    supportsReasoning: false,
    contextWindow: null,
    maxOutput: null,
    priceInPer1m: null,
    priceOutPer1m: null,
    priceCachedPer1m: null,
    currency: 'USD',
    ...overrides,
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'profile-1',
    name: 'Everyday',
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'llama3.2',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    ...overrides,
  };
}

function reset(): void {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  mockedCreate.mockReset();
  mockedPatch.mockReset();
  mockedDelete.mockReset();
}

describe('ProfilesPanel', () => {
  beforeEach(reset);
  afterEach(cleanup);

  it('creates a new profile with connection, model and tool policy', async () => {
    useGruntStore.getState().setConnections([makeConnection()]);
    useGruntStore.getState().setModels([makeModel()]);
    mockedCreate.mockResolvedValue(makeProfile({ id: 'new-profile', name: 'Fast local' }));
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));

    await user.type(screen.getByLabelText('Profile name'), 'Fast local');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    await user.selectOptions(screen.getByLabelText('Filesystem access'), 'read');
    await user.click(screen.getByLabelText('Shell access'));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Fast local',
          connectionId: 'conn-1',
          modelId: 'llama3.2',
          toolPolicy: { fs: 'read', shell: true, approvalMode: 'always_ask', mcpServerIds: [] },
        })
      )
    );
  });

  it('requires a model to be chosen before saving', async () => {
    useGruntStore.getState().setConnections([makeConnection()]);
    // No models discovered yet -- the model select is empty/disabled.
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'No model yet');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    // Note: the (disabled) model <option> itself also reads "Choose a
    // model" -- match the error paragraph's exact text (with its trailing
    // period) so this doesn't collide with that option.
    expect(await screen.findByText('Choose a model.')).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('numeric params are optional -- blank omits the key, a non-number is rejected', async () => {
    useGruntStore.getState().setConnections([makeConnection()]);
    useGruntStore.getState().setModels([makeModel()]);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Bad temp');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    await user.type(screen.getByLabelText('Temperature'), 'not-a-number');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/params must be numbers/i)).toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('leaving every param field blank sends an empty params object', async () => {
    useGruntStore.getState().setConnections([makeConnection()]);
    useGruntStore.getState().setModels([makeModel()]);
    mockedCreate.mockResolvedValue(makeProfile());
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Profile name'), 'Plain');
    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-1');
    await user.selectOptions(screen.getByLabelText('Model'), 'llama3.2');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ params: {} })));
  });

  it('editing an existing profile pre-fills its fields (name, params, tool policy)', async () => {
    useGruntStore.getState().setConnections([makeConnection()]);
    useGruntStore.getState().setModels([makeModel()]);
    useGruntStore.getState().setProfiles([
      makeProfile({
        name: 'Careful reviewer',
        params: { temperature: 0.2, topP: 0.9 },
        toolPolicy: { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate' },
        isDefault: true,
      }),
    ]);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));

    expect(screen.getByLabelText('Profile name')).toHaveValue('Careful reviewer');
    expect(screen.getByLabelText('Temperature')).toHaveValue('0.2');
    expect(screen.getByLabelText('Top P')).toHaveValue('0.9');
    expect(screen.getByLabelText('Filesystem access')).toHaveValue('readwrite');
    expect(screen.getByLabelText('Shell access')).toBeChecked();
    expect(screen.getByLabelText('Approval mode')).toHaveValue('ask_on_mutate');
    expect(screen.getByLabelText('Default profile')).toBeChecked();
  });

  it('resetting the model when switching to a connection with no shared models', async () => {
    useGruntStore.getState().setConnections([makeConnection({ id: 'conn-1', name: 'Ollama' }), makeConnection({ id: 'conn-2', name: 'OpenAI' })]);
    useGruntStore.getState().setModels([makeModel({ id: 'm1', connectionId: 'conn-1', modelId: 'llama3.2' })]);
    useGruntStore.getState().setProfiles([makeProfile({ connectionId: 'conn-1', modelId: 'llama3.2' })]);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    expect(screen.getByLabelText('Model')).toHaveValue('llama3.2');

    await user.selectOptions(screen.getByLabelText('Connection'), 'conn-2');

    // conn-2 has no models at all -- the model select must not still claim "llama3.2" is selected.
    expect(screen.getByLabelText('Model')).toHaveDisplayValue(/choose a model/i);
  });

  it('deleting a profile confirms first and warns that dependent chats are deleted too', async () => {
    useGruntStore.getState().setConnections([makeConnection()]);
    useGruntStore.getState().setModels([makeModel()]);
    useGruntStore.getState().setProfiles([makeProfile({ id: 'profile-1', name: 'Doomed' })]);
    mockedDelete.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('profile-1'));
    expect(confirmSpy.mock.calls[0]?.[0]).toMatch(/chat built on this profile is deleted/i);
    expect(screen.queryByTestId('profile-row-profile-1')).not.toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  it('surfaces the server error instead of throwing when delete is refused', async () => {
    useGruntStore.getState().setConnections([makeConnection()]);
    useGruntStore.getState().setModels([makeModel()]);
    useGruntStore.getState().setProfiles([makeProfile({ id: 'profile-1' })]);
    mockedDelete.mockRejectedValue(new Error('nope'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();

    render(<ProfilesPanel />);
    await user.click(screen.getByTestId('profile-row-profile-1'));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/delete failed/i)).toBeInTheDocument();
    // The row must still be there -- the delete did not silently succeed client-side.
    expect(screen.getByTestId('profile-row-profile-1')).toBeInTheDocument();
  });
});
