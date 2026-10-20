import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, chats: { ...actual.api.chats, patch: vi.fn() } } };
});

import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { Message } from '../components/Message.js';
import { ConversationStrip } from './ConversationStrip.js';

const mockedPatch = vi.mocked(api.chats.patch);

const makeChat = (head: string | null): Chat => ({
  id: 'chat-1', title: 'Chat 1', profileId: 'p1', headMessageId: head, workspace: null, runsOn: 'node-self', workspaceRoot: null,
  pinned: false, projectPinned: false, unread: false, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, archivedAt: null, createdAt: 1, updatedAt: 1,
});
const msg = (id: string, overrides: Partial<CanonMessage>): CanonMessage => ({
  id, chatId: 'chat-1', parentId: null, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 0, ...overrides,
});
const user = (id: string, parentId: string | null, text: string): CanonMessage => msg(id, { role: 'user', parentId, parts: [{ type: 'text', text }] });
const reply = (id: string, parentId: string, text: string, status: CanonMessage['status'] = 'complete'): CanonMessage =>
  msg(id, { parentId, status, parts: text ? [{ type: 'text', text }] : [] });

const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  window.matchMedia = originalMatchMedia;
  mockedPatch.mockReset();
});

/** Puts the window in (or out of) the narrow layout. */
function narrow(matches: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const renderFor = (head: string | null): void => {
  render(<ConversationStrip chat={makeChat(head)} />);
};
const open = async (): Promise<void> => {
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show conversation outline' }));
};

describe('ConversationStrip', () => {
  it('with no user message shows just the title and pin toggle', () => {
    renderFor(null);
    const header = screen.getByRole('region', { name: 'Conversation' });
    expect(header).toHaveTextContent('Chat 1');
    expect(within(header).getByRole('button', { name: 'Pin chat' })).toBeInTheDocument();
    expect(header).not.toHaveTextContent('prompt');
    expect(screen.queryByRole('button', { name: 'Show conversation outline' })).toBeNull();
  });

  it('is collapsed by default: title, count, latest prompt preview, no list', () => {
    useOtherBenchStore.getState().loadMessages('chat-1', [user('u1', null, 'first'), reply('a1', 'u1', 'r'), user('u2', 'a1', 'latest question')], null);
    renderFor('u2');
    const strip = screen.getByRole('region', { name: 'Conversation' });
    expect(strip).toHaveTextContent('Chat 1');
    expect(strip).toHaveTextContent('· 2 prompts');
    expect(strip).toHaveTextContent('latest question');
    expect(screen.queryByTestId('outline-u1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show conversation outline' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('uses the singular for one prompt', () => {
    useOtherBenchStore.getState().loadMessages('chat-1', [user('u1', null, 'only')], null);
    renderFor('u1');
    expect(screen.getByRole('region', { name: 'Conversation' })).toHaveTextContent('· 1 prompt');
    expect(screen.getByRole('region', { name: 'Conversation' })).not.toHaveTextContent('1 prompts');
  });

  it('the pin toggle pins and unpins the chat', async () => {
    const c = makeChat(null);
    useOtherBenchStore.setState({ chats: [c] });
    mockedPatch.mockResolvedValueOnce({ ...c, pinned: true });
    render(<ConversationStrip chat={c} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pin chat' }));
    expect(mockedPatch).toHaveBeenCalledWith('chat-1', { pinned: true });
    await waitFor(() => expect(useOtherBenchStore.getState().chats[0]!.pinned).toBe(true));
    cleanup();
    render(<ConversationStrip chat={{ ...c, pinned: true }} />);
    expect(screen.getByRole('button', { name: 'Unpin chat' })).toBeInTheDocument();
  });

  it('has no pin toggle for an archived chat, as the row and menu have none', () => {
    render(<ConversationStrip chat={{ ...makeChat(null), archivedAt: 5 }} />);
    expect(screen.queryByRole('button', { name: /pin chat/i })).toBeNull();
  });

  it('says so when pinning fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedPatch.mockRejectedValueOnce(new Error('offline'));
    renderFor(null);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pin chat' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't pin the chat");
    expect(alert).toHaveClass('truncate');
    expect(alert).toHaveAttribute('title', "Couldn't pin the chat");
    error.mockRestore();
  });

  it('shows the connection status only when there is something to say', () => {
    renderFor(null);
    expect(screen.queryByTestId('stream-status')).toBeNull();
    cleanup();
    useOtherBenchStore.setState({ streamStatus: 'reconnecting' });
    renderFor(null);
    expect(screen.getByTestId('stream-status')).toHaveTextContent('Reconnecting…');
    expect(screen.getByTestId('stream-status')).toHaveClass('min-w-0', 'truncate');
    expect(screen.getByTestId('stream-status')).toHaveAttribute('title', 'Reconnecting…');
  });

  it('has an Inspector button only in the narrow layout, which opens the overlay', async () => {
    renderFor(null);
    expect(screen.queryByRole('button', { name: 'Inspector' })).toBeNull();
    cleanup();
    narrow(true);
    renderFor(null);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Inspector' }));
    expect(useOtherBenchStore.getState().inspectorOverlayOpen).toBe(true);
  });

  it('has a Viewer toggle when given one, pressed while the viewer is open', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ConversationStrip chat={makeChat(null)} />);
    expect(screen.queryByRole('button', { name: 'Viewer' })).toBeNull();
    rerender(<ConversationStrip chat={makeChat(null)} viewer={{ open: true, onToggle }} />);
    expect(screen.getByRole('button', { name: 'Viewer' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Viewer' }));
    expect(onToggle).toHaveBeenCalled();
  });

  it('keeps its buttons with a very long title', () => {
    narrow(true);
    render(<ConversationStrip chat={{ ...makeChat(null), title: 'x'.repeat(300) }} />);
    expect(screen.getByRole('button', { name: 'Pin chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inspector' })).toBeInTheDocument();
    expect(screen.getByTitle('x'.repeat(300))).toHaveClass('truncate');
  });

  it('expands and collapses with the chevron', async () => {
    useOtherBenchStore.getState().loadMessages('chat-1', [user('u1', null, 'a'), reply('a1', 'u1', 'r'), user('u2', 'a1', 'b')], null);
    renderFor('u2');
    await open();
    expect(screen.getByRole('button', { name: 'Hide conversation outline' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId(/^outline-u/).map((e) => e.getAttribute('data-testid'))).toEqual(['outline-u1', 'outline-u2']);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hide conversation outline' }));
    expect(screen.queryByTestId('outline-u1')).not.toBeInTheDocument();
  });

  it('lists every prompt on the current branch with a truncated reply preview, oldest first', async () => {
    const long = 'x'.repeat(100);
    useOtherBenchStore.getState().loadMessages('chat-1', [
      user('u1', null, 'first question'), reply('a1', 'u1', long),
      user('u2', 'a1', 'second question'), reply('a2', 'u2', '', 'streaming'),
      user('u3', 'a2', 'third question'),
      user('other', 'a1', 'abandoned branch'),
    ], null);
    renderFor('u3');
    await open();
    expect(screen.getByRole('button', { name: 'Go to: first question' })).toBeInTheDocument();
    const entries = screen.getAllByTestId(/^outline-u/);
    expect(entries.map((e) => e.getAttribute('data-testid'))).toEqual(['outline-u1', 'outline-u2', 'outline-u3']);
    expect(entries[0]).toHaveTextContent('x'.repeat(80) + '…');
    expect(entries[0]).not.toHaveTextContent('x'.repeat(81));
    expect(entries[1]).toHaveTextContent('…');
    expect(entries[2]).toHaveTextContent('(no reply)');
    expect(screen.getByRole('region', { name: 'Conversation' })).not.toHaveTextContent('abandoned branch');
  });

  it('names a /clear or /compact line by what it did, and peeks at a compact summary', async () => {
    useOtherBenchStore.getState().loadMessages('chat-1', [
      user('u1', null, 'first'), reply('a1', 'u1', 'r'),
      msg('k1', { role: 'user', parentId: 'a1', parts: [{ type: 'context', kind: 'compact', focus: 'the API' }] }),
      msg('s1', { parentId: 'k1', parts: [{ type: 'context-summary', text: 'We built   the API.' }] }),
      msg('c1', { role: 'user', parentId: 's1', parts: [{ type: 'context', kind: 'clear' }] }),
    ], null);
    renderFor('c1');
    const strip = screen.getByRole('region', { name: 'Conversation' });
    expect(strip).toHaveTextContent('Context cleared');
    expect(strip).not.toHaveTextContent('(attachment)');
    await open();
    expect(screen.getByTestId('outline-k1')).toHaveTextContent('Context compacted');
    expect(screen.getByTestId('outline-k1')).toHaveTextContent('We built the API.');
    expect(screen.getByTestId('outline-c1')).toHaveTextContent('Context cleared');
    expect(screen.getByTestId('outline-c1')).not.toHaveTextContent('(no reply)');
    expect(screen.getByTestId('outline-k1')).not.toHaveTextContent('(no reply)');
    expect(screen.getByRole('button', { name: 'Go to: Context cleared' })).toBeInTheDocument();
  });

  it('Go to a context line scrolls to the line Message draws', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const clear = msg('c1', { role: 'user', parentId: 'a1', parts: [{ type: 'context', kind: 'clear' }] });
    useOtherBenchStore.getState().loadMessages('chat-1', [user('u1', null, 'a'), reply('a1', 'u1', 'r'), clear], null);
    render(<Message message={clear} />);
    const target = document.getElementById('msg-c1')!;
    const spy = vi.spyOn(target, 'scrollIntoView');
    renderFor('c1');
    await open();
    await userEvent.setup().click(screen.getByTestId('outline-c1'));
    expect(spy).toHaveBeenCalledWith({ block: 'start' });
  });

  it('truncates long user text to one line of about 60 characters', async () => {
    useOtherBenchStore.getState().loadMessages('chat-1', [user('u1', null, `${'y'.repeat(70)}\nsecond line`)], null);
    renderFor('u1');
    await open();
    const entry = screen.getByTestId('outline-u1');
    expect(entry).toHaveTextContent('y'.repeat(60) + '…');
    expect(entry).not.toHaveTextContent('second line');
  });

  it('scrolls the thread to the clicked message and stays open', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const target = document.createElement('article');
    target.id = 'msg-u2';
    document.body.appendChild(target);
    const spy = vi.spyOn(target, 'scrollIntoView');
    useOtherBenchStore.getState().loadMessages('chat-1', [user('u1', null, 'a'), reply('a1', 'u1', 'r'), user('u2', 'a1', 'b')], null);
    renderFor('u2');
    await open();
    await userEvent.setup().click(screen.getByTestId('outline-u2'));
    expect(spy).toHaveBeenCalledWith({ block: 'start' });
    expect(screen.getByTestId('outline-u2')).toBeInTheDocument();
    target.remove();
  });

  it('persists the open state per device in localStorage', async () => {
    useOtherBenchStore.getState().loadMessages('chat-1', [user('u1', null, 'a')], null);
    renderFor('u1');
    await open();
    expect(window.localStorage.getItem('otherbench.outlineOpen')).toBe('1');
    cleanup();
    renderFor('u1');
    expect(screen.getByTestId('outline-u1')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hide conversation outline' }));
    expect(window.localStorage.getItem('otherbench.outlineOpen')).toBe('0');
    cleanup();
    renderFor('u1');
    expect(screen.queryByTestId('outline-u1')).not.toBeInTheDocument();
  });

  it('still works when localStorage throws', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    useOtherBenchStore.getState().loadMessages('chat-1', [user('u1', null, 'a')], null);
    renderFor('u1');
    await open();
    expect(within(screen.getByRole('region', { name: 'Conversation' })).getByTestId('outline-u1')).toBeInTheDocument();
    get.mockRestore();
    set.mockRestore();
  });
});
