import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { useGruntStore } from '../state/store.js';
import { ConversationStrip } from './ConversationStrip.js';

const makeChat = (head: string | null): Chat => ({
  id: 'chat-1', title: 'Chat 1', profileId: 'p1', headMessageId: head, workspaceRoot: null,
  pinned: false, autoMode: false, projectId: null, memoryCursor: null, memoryExcluded: false, archivedAt: null, createdAt: 1, updatedAt: 1,
});
const msg = (id: string, overrides: Partial<CanonMessage>): CanonMessage => ({
  id, chatId: 'chat-1', parentId: null, role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null, createdAt: 0, ...overrides,
});
const user = (id: string, parentId: string | null, text: string): CanonMessage => msg(id, { role: 'user', parentId, parts: [{ type: 'text', text }] });
const reply = (id: string, parentId: string, text: string, status: CanonMessage['status'] = 'complete'): CanonMessage =>
  msg(id, { parentId, status, parts: text ? [{ type: 'text', text }] : [] });

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

const renderFor = (head: string | null): void => {
  render(<ConversationStrip chat={makeChat(head)} />);
};
const open = async (): Promise<void> => {
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show conversation outline' }));
};

describe('ConversationStrip', () => {
  it('renders nothing when the chat has no user message', () => {
    renderFor(null);
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument();
  });

  it('is collapsed by default: count, latest prompt preview, no list', () => {
    useGruntStore.getState().loadMessages('chat-1', [user('u1', null, 'first'), reply('a1', 'u1', 'r'), user('u2', 'a1', 'latest question')], null);
    renderFor('u2');
    const strip = screen.getByRole('region', { name: 'Conversation' });
    expect(strip).toHaveTextContent('Conversation · 2 prompts');
    expect(strip).toHaveTextContent('latest question');
    expect(screen.queryByTestId('outline-u1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show conversation outline' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('uses the singular for one prompt', () => {
    useGruntStore.getState().loadMessages('chat-1', [user('u1', null, 'only')], null);
    renderFor('u1');
    expect(screen.getByRole('region', { name: 'Conversation' })).toHaveTextContent('Conversation · 1 prompt');
    expect(screen.getByRole('region', { name: 'Conversation' })).not.toHaveTextContent('1 prompts');
  });

  it('expands and collapses with the chevron', async () => {
    useGruntStore.getState().loadMessages('chat-1', [user('u1', null, 'a'), reply('a1', 'u1', 'r'), user('u2', 'a1', 'b')], null);
    renderFor('u2');
    await open();
    expect(screen.getByRole('button', { name: 'Hide conversation outline' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId(/^outline-u/).map((e) => e.getAttribute('data-testid'))).toEqual(['outline-u1', 'outline-u2']);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hide conversation outline' }));
    expect(screen.queryByTestId('outline-u1')).not.toBeInTheDocument();
  });

  it('lists every prompt on the current branch with a truncated reply preview, oldest first', async () => {
    const long = 'x'.repeat(100);
    useGruntStore.getState().loadMessages('chat-1', [
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

  it('truncates long user text to one line of about 60 characters', async () => {
    useGruntStore.getState().loadMessages('chat-1', [user('u1', null, `${'y'.repeat(70)}\nsecond line`)], null);
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
    useGruntStore.getState().loadMessages('chat-1', [user('u1', null, 'a'), reply('a1', 'u1', 'r'), user('u2', 'a1', 'b')], null);
    renderFor('u2');
    await open();
    await userEvent.setup().click(screen.getByTestId('outline-u2'));
    expect(spy).toHaveBeenCalledWith({ block: 'start' });
    expect(screen.getByTestId('outline-u2')).toBeInTheDocument();
    target.remove();
  });

  it('persists the open state per device in localStorage', async () => {
    useGruntStore.getState().loadMessages('chat-1', [user('u1', null, 'a')], null);
    renderFor('u1');
    await open();
    expect(window.localStorage.getItem('grunt.outlineOpen')).toBe('1');
    cleanup();
    renderFor('u1');
    expect(screen.getByTestId('outline-u1')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Hide conversation outline' }));
    expect(window.localStorage.getItem('grunt.outlineOpen')).toBe('0');
    cleanup();
    renderFor('u1');
    expect(screen.queryByTestId('outline-u1')).not.toBeInTheDocument();
  });

  it('still works when localStorage throws', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    useGruntStore.getState().loadMessages('chat-1', [user('u1', null, 'a')], null);
    renderFor('u1');
    await open();
    expect(within(screen.getByRole('region', { name: 'Conversation' })).getByTestId('outline-u1')).toBeInTheDocument();
    get.mockRestore();
    set.mockRestore();
  });
});
