import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_FORMAT_ERROR, emptyMemoryBody, type MemoryUpdateOutcome, type ProjectMemoryView } from '@grunt/core/domain/memory.js';
import type { Chat, Project, ProjectMemory } from '@grunt/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      memory: { get: vi.fn(), save: vi.fn(), versions: vi.fn(), version: vi.fn(), restore: vi.fn(), updateNow: vi.fn() },
    },
  };
});

import { ApiError, api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { InspectorMemory } from './InspectorMemory.js';

const m = vi.mocked(api.memory);

const NOTE = '## Pinned\n- Stay on SQLite\n\n## Goals\n- Ship memory\n\n## Decisions\n\n## Current focus\n\n## Open questions';
const project: Project = { id: 'proj', name: 'Alpha', description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };

function chat(over: Partial<Chat> = {}): Chat {
  return {
    id: 'c-plan',
    title: 'Planning',
    profileId: 'p',
    headMessageId: null,
    workspace: null,
    runsOn: 'node-self',
    workspaceRoot: null,
    pinned: false,
    archivedAt: null,
    autoMode: false,
    projectId: 'proj',
    memoryCursor: null,
    memoryExcluded: false,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function view(over: Partial<ProjectMemory> = {}, lastError: ProjectMemoryView['lastError'] = null): ProjectMemoryView {
  return {
    memory: { projectId: 'proj', body: NOTE, updatedAt: Date.now() - 120_000, updatedBy: 'summariser', sourceChatId: 'c-plan', ...over },
    lastError,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ chats: [chat()] });
  m.get.mockReset().mockResolvedValue(view());
  m.save.mockReset();
  m.versions.mockReset().mockResolvedValue([]);
  m.version.mockReset();
  m.restore.mockReset();
  m.updateNow.mockReset();
});

afterEach(cleanup);

describe('InspectorMemory', () => {
  it('renders the note and says which chat last updated it', async () => {
    render(<InspectorMemory chat={chat()} project={project} />);
    expect(await screen.findByText('Ship memory')).toBeInTheDocument();
    expect(screen.getByTestId('memory-updated')).toHaveTextContent('Updated 2 min ago from Planning');
    expect(m.get).toHaveBeenCalledWith('proj');
  });

  it('says "by you" after a user save, names a deleted chat, and says "Not saved yet" for a new project', async () => {
    m.get.mockResolvedValueOnce(view({ updatedBy: 'user', sourceChatId: null }));
    render(<InspectorMemory chat={chat()} project={project} />);
    await waitFor(() => expect(screen.getByTestId('memory-updated')).toHaveTextContent('Updated 2 min ago by you'));
    cleanup();

    m.get.mockResolvedValueOnce(view({ sourceChatId: 'gone' }));
    render(<InspectorMemory chat={chat()} project={project} />);
    await waitFor(() => expect(screen.getByTestId('memory-updated')).toHaveTextContent('from a deleted chat'));
    cleanup();

    m.get.mockResolvedValueOnce(view({ body: emptyMemoryBody(), updatedAt: 0, updatedBy: 'user', sourceChatId: null }));
    render(<InspectorMemory chat={chat()} project={project} />);
    await waitFor(() => expect(screen.getByTestId('memory-updated')).toHaveTextContent('Not saved yet'));
    expect(screen.getByText("Nothing in this project's memory yet.")).toBeInTheDocument();
  });

  it('Edit: an invalid note shows why and saves nothing; a valid one saves and shows', async () => {
    const user = userEvent.setup();
    const saved = NOTE.replace('- Ship memory', '- Ship memory\n- Write docs');
    m.save.mockResolvedValue(view({ body: saved, updatedBy: 'user', sourceChatId: null, updatedAt: Date.now() }));
    render(<InspectorMemory chat={chat()} project={project} />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const box = screen.getByRole('textbox', { name: 'Project memory' });
    expect(box).toHaveValue(NOTE);
    fireEvent.change(box, { target: { value: '## Goals\n- Only goals' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('memory-edit-error')).toHaveTextContent(MEMORY_FORMAT_ERROR);
    expect(m.save).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: saved } });
    expect(screen.queryByTestId('memory-edit-error')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(m.save).toHaveBeenCalledWith('proj', saved);
    expect(await screen.findByText('Write docs')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Project memory' })).toBeNull();
    expect(screen.getByTestId('memory-updated')).toHaveTextContent('by you');
  });

  it("Edit shows the server's message when saving fails, and Cancel leaves the note as it was", async () => {
    const user = userEvent.setup();
    m.save.mockRejectedValue(new ApiError(400, 'The note is empty.'));
    render(<InspectorMemory chat={chat()} project={project} />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('memory-edit-error')).toHaveTextContent('The note is empty.');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Project memory' })).toBeNull();
    expect(screen.getByText('Ship memory')).toBeInTheDocument();
  });

  it('Update now shows progress, then the outcome, and re-reads the note', async () => {
    const user = userEvent.setup();
    const pending = deferred<MemoryUpdateOutcome>();
    m.updateNow.mockReturnValue(pending.promise);
    render(<InspectorMemory chat={chat()} project={project} />);
    await user.click(await screen.findByRole('button', { name: 'Update now' }));

    const busy = screen.getByRole('button', { name: 'Updating…' });
    expect(busy).toBeDisabled();
    expect(m.updateNow).toHaveBeenCalledWith('c-plan');

    m.get.mockResolvedValue(view({ body: NOTE.replace('- Ship memory', '- Ship it'), updatedAt: Date.now() }));
    pending.resolve({ status: 'updated', memory: view().memory });
    expect(await screen.findByTestId('memory-notice')).toHaveTextContent('Memory updated.');
    expect(await screen.findByText('Ship it')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update now' })).toBeEnabled();
  });

  it.each<[MemoryUpdateOutcome, string]>([
    [{ status: 'unchanged' }, 'Memory checked: nothing needed changing.'],
    [{ status: 'nothing-new' }, 'Nothing new in this chat to add.'],
    [{ status: 'discarded', reason: 'The note was edited while the update ran.' }, 'The note was edited while the update ran.'],
    [{ status: 'failed', error: "Memory update failed: The model didn't answer within 120 s." }, "Memory update failed: The model didn't answer within 120 s."],
  ])('Update now reports %j', async (outcome, text) => {
    const user = userEvent.setup();
    m.updateNow.mockResolvedValue(outcome);
    render(<InspectorMemory chat={chat()} project={project} />);
    await user.click(await screen.findByRole('button', { name: 'Update now' }));
    expect(await screen.findByTestId('memory-notice')).toHaveTextContent(text);
  });

  it("Update now is disabled for a chat that doesn't add to memory", async () => {
    render(<InspectorMemory chat={chat({ memoryExcluded: true })} project={project} />);
    expect(await screen.findByRole('button', { name: 'Update now' })).toBeDisabled();
  });

  it('shows the last automatic failure with Retry, which re-runs the update for the chat that failed', async () => {
    const user = userEvent.setup();
    m.get.mockResolvedValue(view({}, { message: 'No model available for project memory', at: Date.now() - 60_000, chatId: 'c-other' }));
    m.updateNow.mockResolvedValue({ status: 'nothing-new' });
    render(<InspectorMemory chat={chat()} project={project} />);

    const alert = await screen.findByTestId('memory-error');
    expect(alert).toHaveTextContent('No model available for project memory');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(m.updateNow).toHaveBeenCalledWith('c-other');
  });

  it('History lists versions with their author and source chat; View shows one; Restore makes it the note', async () => {
    const user = userEvent.setup();
    const older = NOTE.replace('- Ship memory', '- Older goal');
    m.versions.mockResolvedValue([
      { id: 'v2', createdAt: Date.now() - 60_000, createdBy: 'user', sourceChatId: null, length: NOTE.length },
      { id: 'v1', createdAt: Date.now() - 3_600_000, createdBy: 'summariser', sourceChatId: 'c-plan', length: older.length },
    ]);
    m.version.mockResolvedValue({ id: 'v1', projectId: 'proj', body: older, createdAt: 1, createdBy: 'summariser', sourceChatId: 'c-plan' });
    m.restore.mockResolvedValue(view({ body: older, updatedBy: 'user', sourceChatId: null, updatedAt: Date.now() }));
    render(<InspectorMemory chat={chat()} project={project} />);

    const toggle = await screen.findByRole('button', { name: 'History' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByTestId('memory-version-v2')).toHaveTextContent('You');
    const v1 = screen.getByTestId('memory-version-v1');
    expect(v1).toHaveTextContent('Planning');

    await user.click(within(v1).getByRole('button', { name: 'View' }));
    expect(m.version).toHaveBeenCalledWith('proj', 'v1');
    expect(await screen.findByTestId('memory-version-body')).toHaveTextContent('Older goal');

    await user.click(within(v1).getByRole('button', { name: 'Restore' }));
    expect(m.restore).toHaveBeenCalledWith('proj', 'v1');
    expect(await screen.findByTestId('memory-notice')).toHaveTextContent('Version restored.');
    expect(within(screen.getByTestId('memory-note')).getByText('Older goal')).toBeInTheDocument();
  });

  it("says so when the note can't be loaded", async () => {
    m.get.mockRejectedValue(new Error('offline'));
    render(<InspectorMemory chat={chat()} project={project} />);
    expect(await screen.findByText("Couldn't load project memory.")).toBeInTheDocument();
  });
});
