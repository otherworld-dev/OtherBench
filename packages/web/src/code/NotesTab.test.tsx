import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotesView } from '@otherbench/core/domain/app-notes.js';
import type { App } from '@otherbench/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: { ...actual.api, appNotes: { get: vi.fn(), save: vi.fn(), versions: vi.fn(), version: vi.fn(), restore: vi.fn() } },
  };
});

import { api } from '../state/api.js';
import { useAppNotesStore } from '../state/appNotes.js';
import { useOtherBenchStore } from '../state/store.js';
import { mirrorLine, NotesTab } from './NotesTab.js';

const app: App = {
  id: 'a1', name: 'OtherBench', workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: 'Otherworld Dev', wikiPagePath: 'Products/OtherBench', bookmarkTag: null, folderId: null, open: true, sortOrder: 0, createdAt: 1, updatedAt: 1,
};
const view = (body: string, mirror: AppNotesView['mirror'] = { state: 'mirrored', at: 5, url: 'https://nc.example/notes' }): AppNotesView => ({
  notes: { appId: 'a1', body, updatedAt: 5, sourceChatId: null, mirroredAt: 5 },
  mirror,
});

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useAppNotesStore.setState({ views: {}, failed: {}, cards: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NotesTab', () => {
  it('shows the notes and their Collectives copy, and saves an edit', async () => {
    vi.mocked(api.appNotes.get).mockResolvedValue(view('## Build\n- Run npm run build first\n'));
    vi.mocked(api.appNotes.save).mockResolvedValue(view('## Build\n- changed\n'));
    const user = userEvent.setup();
    render(<NotesTab app={app} />);
    expect(await screen.findByText('Run npm run build first')).toBeInTheDocument();
    expect(screen.getByTestId('app-notes-mirror')).toHaveTextContent('Copied to Collectives.');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'App notes' });
    await user.clear(box);
    await user.type(box, '## Build{enter}- changed');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.appNotes.save).toHaveBeenCalledWith('a1', '## Build\n- changed');
    expect(await screen.findByText('changed')).toBeInTheDocument();
  });

  it('says when there are no notes yet', async () => {
    vi.mocked(api.appNotes.get).mockResolvedValue(view('## Build\n\n## Release\n', { state: 'nothing' }));
    render(<NotesTab app={app} />);
    expect(await screen.findByText('No notes yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('app-notes-mirror')).toBeNull();
  });
});

describe('mirrorLine', () => {
  it('names each state', () => {
    expect(mirrorLine({ state: 'no-page' })!.text).toMatch(/wiki page/);
    expect(mirrorLine({ state: 'failed', at: Date.now(), error: 'down' })).toMatchObject({ failed: true });
    expect(mirrorLine({ state: 'nothing' })).toBeNull();
  });
});
