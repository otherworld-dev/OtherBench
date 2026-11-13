import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatSend } from '@otherbench/core/ports/store.js';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      chatSends: { forChat: vi.fn(), waiting: vi.fn(), stop: vi.fn() },
    },
  };
});

import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { ChatSendCard } from './ChatSendCard.js';
import { ChatLinkBadge } from './ChatLinkBadge.js';

function send(over: Partial<ChatSend> = {}): ChatSend {
  return {
    id: 's1', chainId: 'r1', depth: 1, fromChatId: 'A', fromMessageId: 'r1', toChatId: 'B', createdChat: false, text: 'x',
    status: 'running', toReplyId: 'rb', replyText: null, reason: null, resumedAs: null, createdAt: 1, finishedAt: null,
    toNode: null, fromNode: null, toAppId: null, fromTitle: null, handedAt: null, reportedAt: null, stopPending: null, heldReason: null, heldSeen: false, chainBase: 0, ...over,
  };
}

beforeEach(() => {
  useOtherBenchStore.setState({
    chats: [
      { id: 'B', title: 'Web work', appId: 'app1' } as never,
      { id: 'C', title: 'Server work', appId: null } as never,
    ],
    apps: [{ id: 'app1', name: 'Web' } as never],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatSendCard', () => {
  it("shows one row per send of this reply with the chat, its app and where it is, and Stop while any is out", async () => {
    vi.mocked(api.chatSends.forChat).mockResolvedValue({
      sends: [send(), send({ id: 's2', toChatId: 'C', status: 'failed', reason: 'No folder here.' }), send({ id: 'other', fromMessageId: 'r9' })],
    });
    vi.mocked(api.chatSends.stop).mockResolvedValue({ sends: [] });
    render(<ChatSendCard chatId="A" fromMessageId="r1" />);
    await waitFor(() => expect(screen.getAllByTestId('chat-send-row')).toHaveLength(2));
    const [b, c] = screen.getAllByTestId('chat-send-row');
    expect(b).toHaveTextContent('Web work');
    expect(b).toHaveTextContent('Web');
    expect(b).toHaveTextContent('Working');
    expect(c).toHaveTextContent('Failed: No folder here.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.chatSends.stop).toHaveBeenCalledWith('r1');
  });

  it('has no Stop once every send has settled', async () => {
    vi.mocked(api.chatSends.forChat).mockResolvedValue({ sends: [send({ status: 'replied' })] });
    render(<ChatSendCard chatId="A" fromMessageId="r1" />);
    await waitFor(() => expect(screen.getByTestId('chat-send-row')).toHaveTextContent('Replied'));
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
  });

  it('says when the replies were not passed back because this chat was cleared', async () => {
    vi.mocked(api.chatSends.forChat).mockResolvedValue({ sends: [send({ status: 'replied', resumedAs: 'none' })] });
    render(<ChatSendCard chatId="A" fromMessageId="r1" />);
    await waitFor(() => expect(screen.getByTestId('chat-send-dropped')).toHaveTextContent(/not passed back/));
  });

  it('opens the chat a row names', async () => {
    vi.mocked(api.chatSends.forChat).mockResolvedValue({ sends: [send()] });
    const open = vi.fn();
    useOtherBenchStore.setState({ setActiveChatId: open });
    render(<ChatSendCard chatId="A" fromMessageId="r1" />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Web work' }));
    expect(open).toHaveBeenCalledWith('B');
  });
});

describe('ChatLinkBadge', () => {
  it('says which chat sent a message, and which chats replied, each opening that chat', async () => {
    const open = vi.fn();
    useOtherBenchStore.setState({ setActiveChatId: open });
    const { rerender } = render(<ChatLinkBadge part={{ type: 'chat-link', kind: 'from', chats: [{ chatId: 'A', title: 'Planning' }], sendIds: ['s1'] }} />);
    expect(screen.getByTestId('chat-link')).toHaveTextContent('From Planning');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Planning' }));
    expect(open).toHaveBeenCalledWith('A');
    rerender(<ChatLinkBadge part={{ type: 'chat-link', kind: 'replies', chats: [{ chatId: 'B', title: 'Web work' }, { chatId: 'C', title: 'Server work' }], sendIds: ['s1', 's2'] }} />);
    expect(screen.getByTestId('chat-link')).toHaveTextContent('Replies from Web work, Server work');
  });
});
