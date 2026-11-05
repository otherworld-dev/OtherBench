import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotesView } from '@otherbench/core/domain/app-notes.js';
import type { Chat } from '@otherbench/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      appNotes: { get: vi.fn(), addFact: vi.fn(), editFact: vi.fn(), moveFact: vi.fn(), undoFact: vi.fn() },
    },
  };
});

import { api } from '../state/api.js';
import { useAppNotesStore } from '../state/appNotes.js';
import { useOtherBenchStore } from '../state/store.js';
import { FactCards, TextWithNoteOffers } from './AppNoteCards.js';

const BODY = '## Build\n- old line\n\n## Release\n';
const view = (body: string): AppNotesView => ({ notes: { appId: 'app-1', body, updatedAt: 1, sourceChatId: null, mirroredAt: null }, mirror: { state: 'pending' } });

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ chats: [{ id: 'chat-1', appId: 'app-1' } as Chat, { id: 'chat-2', appId: null } as Chat] });
  useAppNotesStore.setState({ views: {}, failed: {}, cards: {} });
  vi.mocked(api.appNotes.get).mockResolvedValue(view(BODY));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TextWithNoteOffers', () => {
  it('shows an offer as a card and saves it with its heading when Save is pressed', async () => {
    vi.mocked(api.appNotes.addFact).mockResolvedValue({
      ...view(`${BODY}- needs --target x86_64\n`),
      fact: { body: '', section: 'Release', line: '- needs --target x86_64', replaced: null, added: true },
    });
    const user = userEvent.setup();
    render(<TextWithNoteOffers chatId="chat-1" text={'It built.\n\n<save-note section="Release">needs --target x86_64</save-note>'} />);
    expect(screen.getByText('It built.')).toBeInTheDocument();
    expect(screen.getByText('Save to notes? · Release')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.appNotes.addFact).toHaveBeenCalledWith('app-1', { text: 'needs --target x86_64', section: 'Release', chatId: 'chat-1' });
    expect(await screen.findByText('Saved to notes · Release')).toBeInTheDocument();
  });

  it('shows Saved for a fact the notes already hold, and No hides the card', async () => {
    const user = userEvent.setup();
    render(<TextWithNoteOffers chatId="chat-1" text={'<save-note>Old line</save-note><save-note>Brand new</save-note>'} />);
    expect(await screen.findByText('Saved to notes')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.queryByText('Brand new')).toBeNull();
    expect(api.appNotes.addFact).not.toHaveBeenCalled();
  });

  it('shows an offer as a plain line outside an app chat', () => {
    render(<TextWithNoteOffers chatId="chat-2" text={'<save-note>Something</save-note>'} />);
    expect(screen.getByText('Something')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});

describe('FactCards', () => {
  const card = { id: 'k1', appId: 'app-1', fact: { body: '', section: 'Build', line: '- new line', replaced: '- old line', added: true }, state: 'saved' as const };

  it('shows the saved line and what it replaced, and Undo takes it back', async () => {
    vi.mocked(api.appNotes.undoFact).mockResolvedValue(view(BODY));
    useAppNotesStore.getState().addCard('chat-1', card);
    const user = userEvent.setup();
    render(<FactCards chatId="chat-1" />);
    expect(screen.getByText('new line')).toBeInTheDocument();
    expect(screen.getByText('old line')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(api.appNotes.undoFact).toHaveBeenCalledWith('app-1', card.fact);
    expect(await screen.findByText(/Taken back out/)).toBeInTheDocument();
  });

  it('moves the line to another heading', async () => {
    vi.mocked(api.appNotes.moveFact).mockResolvedValue(view('## Build\n\n## Release\n- new line\n'));
    useAppNotesStore.getState().addCard('chat-1', card);
    const user = userEvent.setup();
    render(<FactCards chatId="chat-1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await user.click(screen.getByRole('button', { name: 'Release' }));
    expect(api.appNotes.moveFact).toHaveBeenCalledWith('app-1', '- new line', 'Release');
    expect(useAppNotesStore.getState().cards['chat-1']![0]!.fact.section).toBe('Release');
  });
});

describe('FactCards: a fact the notes already held', () => {
  it('says so and offers no Undo', () => {
    useAppNotesStore.getState().addCard('chat-1', { id: 'k2', appId: 'app-1', fact: { body: '', section: 'Build', line: '- old line', replaced: null, added: false }, state: 'saved' });
    render(<FactCards chatId="chat-1" />);
    expect(screen.getByTestId('fact-card')).toHaveTextContent('Already in');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});
