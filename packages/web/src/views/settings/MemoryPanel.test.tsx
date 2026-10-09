import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGlobalMemoryBody } from '@grunt/core/domain/global-memory.js';
import type { MemoryFailure } from '@grunt/core/domain/memory.js';
import type { Chat, GlobalMemory } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';

vi.mock('../../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state/api.js')>();
  return {
    ...actual,
    api: {
      settings: { get: vi.fn(), patch: vi.fn() },
      memory: { global: { get: vi.fn(), saveAbout: vi.fn(), saveNote: vi.fn(), versions: vi.fn(), version: vi.fn(), restore: vi.fn() } },
    },
  };
});

import { ApiError, api, type GlobalMemoryView } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';
import { MEMORY_MODEL_HINT, MemoryPanel } from './MemoryPanel.js';

const mockedGet = vi.mocked(api.settings.get);
const mockedPatch = vi.mocked(api.settings.patch);
const global = vi.mocked(api.memory.global);

const NOTE = '## Pinned\n- Windows 11\n\n## Preferences\n- British English\n\n## Setup and tools\n\n## Working style';

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

function view(over: Partial<GlobalMemory> = {}, lastError: MemoryFailure | null = null): GlobalMemoryView {
  return {
    memory: { about: '', aboutUpdatedAt: 0, note: emptyGlobalMemoryBody(), noteUpdatedAt: 0, noteUpdatedBy: 'user', noteSourceChatId: null, ...over },
    lastError,
  };
}

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ profiles: [profile('p-cheap', 'Local Llama'), profile('p-big', 'Opus'), profile('p-old', 'Old', 5)], chats: [{ id: 'c1', title: 'Setup chat' } as Chat] });
  mockedGet.mockReset().mockResolvedValue({ memoryProfileId: null });
  mockedPatch.mockReset().mockImplementation(async (body) => ({ memoryProfileId: body.memoryProfileId ?? null }));
  for (const fn of Object.values(global)) fn.mockReset();
  global.get.mockResolvedValue(view());
});

afterEach(cleanup);

describe('MemoryPanel: About you', () => {
  it('loads About you, counts it, and saves a change', async () => {
    global.get.mockResolvedValue(view({ about: 'I am Adam.' }));
    global.saveAbout.mockImplementation(async (about) => view({ about }));
    const user = userEvent.setup();
    render(<MemoryPanel />);

    const box = await screen.findByRole('textbox', { name: 'About you' });
    await waitFor(() => expect(box).toHaveValue('I am Adam.'));
    expect(screen.getByTestId('about-count')).toHaveTextContent('10 / 4,000');
    const save = screen.getByRole('button', { name: 'Save About you' });
    expect(save).toBeDisabled();

    await user.type(box, ' British English.');
    await user.click(save);
    expect(global.saveAbout).toHaveBeenCalledWith('I am Adam. British English.');
    expect(await screen.findByTestId('about-saved')).toHaveTextContent('Saved.');
  });

  it('over 4,000 characters turns the counter red and disables Save', async () => {
    render(<MemoryPanel />);
    const box = await screen.findByRole('textbox', { name: 'About you' });
    fireEvent.change(box, { target: { value: 'x'.repeat(4_001) } });
    expect(screen.getByTestId('about-count')).toHaveTextContent('4,001 / 4,000');
    expect(screen.getByTestId('about-count')).toHaveClass('text-[var(--danger)]');
    expect(screen.getByRole('button', { name: 'Save About you' })).toBeDisabled();
  });

  it("shows the server's message when saving fails", async () => {
    global.saveAbout.mockRejectedValue(new ApiError(400, 'About you is too long.'));
    const user = userEvent.setup();
    render(<MemoryPanel />);
    await user.type(await screen.findByRole('textbox', { name: 'About you' }), 'Hi');
    await user.click(screen.getByRole('button', { name: 'Save About you' }));
    expect(await screen.findByTestId('about-error')).toHaveTextContent('About you is too long.');
  });
});

describe('MemoryPanel: the learned note', () => {
  it('says nothing has been learned yet when the note is empty', async () => {
    render(<MemoryPanel />);
    expect(await screen.findByText(/Nothing learned about you yet/)).toBeInTheDocument();
    expect(screen.getByTestId('global-memory-updated')).toHaveTextContent('Not saved yet');
  });

  it('shows the note and where it came from, refuses a bad edit and saves a good one', async () => {
    global.get.mockResolvedValue(view({ note: NOTE, noteUpdatedAt: Date.now() - 60_000, noteUpdatedBy: 'summariser', noteSourceChatId: 'c1' }));
    global.saveNote.mockImplementation(async (body) => view({ note: body, noteUpdatedAt: Date.now(), noteUpdatedBy: 'user' }));
    const user = userEvent.setup();
    render(<MemoryPanel />);

    expect(await screen.findByTestId('global-memory-note')).toHaveTextContent('British English');
    expect(screen.getByTestId('global-memory-updated')).toHaveTextContent('from Setup chat');

    await user.click(within(screen.getByTestId('global-memory-section')).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('textbox', { name: 'Learned note' });
    fireEvent.change(editor, { target: { value: '## Pinned' } });
    await user.click(within(screen.getByTestId('global-memory-section')).getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('global-memory-edit-error')).toHaveTextContent('## Preferences');
    expect(global.saveNote).not.toHaveBeenCalled();

    const edited = NOTE.replace('British English', 'Concise answers');
    fireEvent.change(editor, { target: { value: edited } });
    await user.click(within(screen.getByTestId('global-memory-section')).getByRole('button', { name: 'Save' }));
    expect(global.saveNote).toHaveBeenCalledWith(edited);
    await waitFor(() => expect(screen.getByTestId('global-memory-note')).toHaveTextContent('Concise answers'));
    expect(screen.getByTestId('global-memory-updated')).toHaveTextContent('by you');
  });

  it('shows the last automatic failure', async () => {
    global.get.mockResolvedValue(view({}, { message: 'No model available for global memory', at: Date.now(), chatId: 'c1' }));
    render(<MemoryPanel />);
    expect(await screen.findByTestId('global-memory-error')).toHaveTextContent('No model available for global memory');
  });
});

describe('MemoryPanel: Memory model', () => {
  function select(): HTMLSelectElement {
    return screen.getByRole('combobox', { name: 'Memory model' }) as HTMLSelectElement;
  }

  it('offers Default plus every live profile, with a privacy hint about what the model reads', async () => {
    render(<MemoryPanel />);
    await waitFor(() => expect(select()).toBeEnabled());
    expect(Array.from(select().options).map((o) => o.textContent)).toEqual(['Default', 'Local Llama', 'Opus']);
    expect(select().value).toBe('');
    expect(screen.getByText(MEMORY_MODEL_HINT)).toBeInTheDocument();
    expect(MEMORY_MODEL_HINT).toContain('reads your chats');
    expect(MEMORY_MODEL_HINT).toContain("a model you're happy to send that content to");
    expect(MEMORY_MODEL_HINT).toContain('a local model keeps it on this machine');
    expect(MEMORY_MODEL_HINT).toContain("each project's default profile");
  });

  it('shows the saved choice and saves a new one', async () => {
    mockedGet.mockResolvedValue({ memoryProfileId: 'p-big' });
    render(<MemoryPanel />);
    await waitFor(() => expect(select().value).toBe('p-big'));

    await userEvent.setup().selectOptions(select(), 'p-cheap');

    expect(mockedPatch).toHaveBeenCalledWith({ memoryProfileId: 'p-cheap' });
    await waitFor(() => expect(select().value).toBe('p-cheap'));
    expect(screen.getByTestId('memory-model-saved')).toHaveTextContent('Saved.');
  });

  it('choosing Default saves null', async () => {
    mockedGet.mockResolvedValue({ memoryProfileId: 'p-big' });
    render(<MemoryPanel />);
    await waitFor(() => expect(select().value).toBe('p-big'));
    await userEvent.setup().selectOptions(select(), '');
    expect(mockedPatch).toHaveBeenCalledWith({ memoryProfileId: null });
  });

  it("shows the server's message when saving fails, and a stored profile that is no longer live reads as Default", async () => {
    mockedGet.mockResolvedValue({ memoryProfileId: 'p-old' });
    mockedPatch.mockRejectedValue(new ApiError(400, '"memoryProfileId": profile "Opus" is archived.'));
    render(<MemoryPanel />);
    await waitFor(() => expect(select()).toBeEnabled());
    expect(select().value).toBe('');

    await userEvent.setup().selectOptions(select(), 'p-big');
    expect(await screen.findByTestId('memory-model-error')).toHaveTextContent('"memoryProfileId": profile "Opus" is archived.');
  });
});
