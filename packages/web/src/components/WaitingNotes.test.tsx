import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplyNote } from '@otherbench/core/types/notes.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, notes: { send: vi.fn(), withdraw: vi.fn() } } };
});
import { api } from '../state/api.js';
import { CLIENT_ID } from '../lib/clientId.js';
import { useOtherBenchStore } from '../state/store.js';
import { WaitingNotes } from './WaitingNotes.js';

const note = (id: string, over: Partial<ReplyNote> = {}): ReplyNote => ({
  id, chatId: 'c1', text: id, attachments: [], path: 'wait', replyIds: ['a1'], parentId: 'a1', profileIds: ['p1'], clientId: CLIENT_ID, sentAt: 1, ...over,
});

beforeEach(() => useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true));
afterEach(() => {
  cleanup();
  vi.mocked(api.notes.withdraw).mockReset();
});

describe('WaitingNotes', () => {
  it('lists waiting notes with their path\'s copy', () => {
    useOtherBenchStore.getState().applyChatEvent('c1', {
      type: 'notes',
      chatId: 'c1',
      notes: [
        note('n1', { text: 'also check the tests', path: 'live', attachments: [{ attachmentId: 'att-1', mime: 'image/png', filename: 'shot.png' }] }),
        note('n2', { text: 'and the docs' }),
      ],
    });
    render(<WaitingNotes chatId="c1" />);
    const items = screen.getAllByTestId('waiting-note');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('also check the tests');
    expect(items[0]).toHaveTextContent('Waiting for Claude to finish its current step');
    expect(within(items[0]!).getByText('shot.png')).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('and the docs');
    expect(items[1]).toHaveTextContent('Sends when the reply finishes');
    expect(screen.getAllByRole('button', { name: 'Take back' })).toHaveLength(2);
  });

  it('shows nothing when no notes wait', () => {
    const { container } = render(<WaitingNotes chatId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('Take back puts the note back in the box', async () => {
    const waiting = note('n1', { text: 'never mind' });
    useOtherBenchStore.getState().noteSent(waiting);
    useOtherBenchStore.getState().applyChatEvent('c1', { type: 'notes', chatId: 'c1', notes: [waiting] });
    vi.mocked(api.notes.withdraw).mockResolvedValue(waiting);
    render(<WaitingNotes chatId="c1" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Take back' }));

    expect(api.notes.withdraw).toHaveBeenCalledWith('c1', 'n1');
    await waitFor(() => expect(useOtherBenchStore.getState().returnedNotes.map((n) => n.id)).toEqual(['n1']));
    // Forgotten as sent, so a later reload can't restore it a second time.
    expect(useOtherBenchStore.getState().sentNotes).toEqual({});
  });

  it('leaves the note alone when Claude had already read it', async () => {
    const waiting = note('n1');
    useOtherBenchStore.getState().noteSent(waiting);
    useOtherBenchStore.getState().applyChatEvent('c1', { type: 'notes', chatId: 'c1', notes: [waiting] });
    vi.mocked(api.notes.withdraw).mockResolvedValue(null);
    render(<WaitingNotes chatId="c1" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Take back' }));

    await waitFor(() => expect(api.notes.withdraw).toHaveBeenCalled());
    expect(useOtherBenchStore.getState().returnedNotes).toEqual([]);
    expect(Object.keys(useOtherBenchStore.getState().sentNotes)).toEqual(['n1']);
  });

  it('says so when taking it back fails', async () => {
    useOtherBenchStore.getState().applyChatEvent('c1', { type: 'notes', chatId: 'c1', notes: [note('n1')] });
    vi.mocked(api.notes.withdraw).mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<WaitingNotes chatId="c1" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Take back' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't take it back. Please try again.");
    vi.mocked(console.error).mockRestore();
  });
});
