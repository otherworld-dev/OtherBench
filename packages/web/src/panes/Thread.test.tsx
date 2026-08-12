import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { useGruntStore } from '../state/store.js';
import { Thread } from './Thread.js';

vi.mock('../state/api.js', () => ({
  api: {
    turns: {
      setHead: vi.fn(),
    },
  },
}));

import { api } from '../state/api.js';

const mockedSetHead = vi.mocked(api.turns.setHead);

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    title: 'Chat 1',
    profileId: 'p1',
    headMessageId: null,
    workspaceRoot: null,
    pinned: false,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeMessage(id: string, chatId: string, overrides: Partial<CanonMessage> = {}): CanonMessage {
  return {
    id,
    chatId,
    parentId: null,
    role: 'user',
    parts: [{ type: 'text', text: `text of ${id}` }],
    status: 'complete',
    error: null,
    producedBy: null,
    createdAt: 0,
    ...overrides,
  };
}

function reset(): void {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  mockedSetHead.mockReset();
}

/**
 * Renders Thread wired to a chat pulled reactively out of the store (as
 * App.tsx does), rather than a static prop -- needed for the optimistic
 * update / revert tests below, where `setHeadMessageId` mutates the store
 * and the component must see that change flow back through as a new
 * `chat.headMessageId`.
 */
function ThreadForChat({ chatId }: { chatId: string }): ReturnType<typeof Thread> {
  const chat = useGruntStore((s) => s.chats.find((c) => c.id === chatId) ?? null);
  return <Thread chat={chat} />;
}

describe('Thread', () => {
  beforeEach(reset);
  afterEach(cleanup);

  // CRITICAL reproduction (task 19/20 brief): Thread must scope tree
  // computation to the active chat. Before the fix, Thread fed
  // `Object.values(messages)` -- the store's flat, cross-chat pool -- into
  // `siblingsOf`/`activePath`, so once two+ chats had been loaded in one
  // session, their unrelated root messages (all `parentId: null`) were
  // grouped as compare-turn siblings of one another. This test must FAIL
  // against the unfixed code.
  it('does not show a compare badge on a chat whose root message merely shares parentId:null with other chats loaded in the same session', () => {
    const rootA = makeMessage('root-a', 'chat-a');
    const rootB = makeMessage('root-b', 'chat-b');
    const rootC = makeMessage('root-c', 'chat-c');

    useGruntStore.getState().loadMessages('chat-a', [rootA], null);
    useGruntStore.getState().loadMessages('chat-b', [rootB], null);
    useGruntStore.getState().loadMessages('chat-c', [rootC], null);

    const chatA = makeChat({ id: 'chat-a', headMessageId: 'root-a' });

    render(<Thread chat={chatA} />);

    expect(screen.getByText('text of root-a')).toBeInTheDocument();
    expect(screen.queryByTestId('compare-seam')).not.toBeInTheDocument();
  });

  it('still shows a compare switcher for a real compare turn within the SAME chat', () => {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    const variantA = makeMessage('variant-a', 'chat-1', {
      parentId: 'root',
      role: 'assistant',
      createdAt: 1,
      parts: [{ type: 'text', text: 'reply A' }],
    });
    const variantB = makeMessage('variant-b', 'chat-1', {
      parentId: 'root',
      role: 'assistant',
      createdAt: 2,
      parts: [{ type: 'text', text: 'reply B' }],
    });
    useGruntStore.getState().loadMessages('chat-1', [root, variantA, variantB], null);
    const chat = makeChat({ headMessageId: 'variant-b' });

    render(<Thread chat={chat} />);

    expect(screen.getByTestId('compare-seam')).toHaveTextContent('2 / 2');
  });

  it('reverts the optimistic head switch and surfaces an error when the server rejects setHead', async () => {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    const variantA = makeMessage('variant-a', 'chat-1', {
      parentId: 'root',
      role: 'assistant',
      createdAt: 1,
      parts: [{ type: 'text', text: 'reply A' }],
    });
    const variantB = makeMessage('variant-b', 'chat-1', {
      parentId: 'root',
      role: 'assistant',
      createdAt: 2,
      parts: [{ type: 'text', text: 'reply B' }],
    });
    useGruntStore.getState().loadMessages('chat-1', [root, variantA, variantB], null);
    useGruntStore.getState().setChats([makeChat({ headMessageId: 'variant-b' })]);
    mockedSetHead.mockRejectedValue(new Error('Bad Request'));

    const user = userEvent.setup();
    render(<ThreadForChat chatId="chat-1" />);

    expect(screen.getByTestId('compare-seam')).toHaveTextContent('2 / 2');
    await user.click(screen.getByLabelText('Previous variant'));

    await waitFor(() => expect(mockedSetHead).toHaveBeenCalledWith('chat-1', 'variant-a'));

    // Reverted back to variant-b once the server rejected the switch.
    await waitFor(() => expect(useGruntStore.getState().chats[0]?.headMessageId).toBe('variant-b'));
    await waitFor(() => expect(screen.getByTestId('compare-seam')).toHaveTextContent('2 / 2'));

    // And the failure is surfaced to the user, not just logged.
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't switch|failed to switch/i);
  });

  it('keeps the optimistic head switch when the server confirms it', async () => {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    const variantA = makeMessage('variant-a', 'chat-1', {
      parentId: 'root',
      role: 'assistant',
      createdAt: 1,
      parts: [{ type: 'text', text: 'reply A' }],
    });
    const variantB = makeMessage('variant-b', 'chat-1', {
      parentId: 'root',
      role: 'assistant',
      createdAt: 2,
      parts: [{ type: 'text', text: 'reply B' }],
    });
    useGruntStore.getState().loadMessages('chat-1', [root, variantA, variantB], null);
    useGruntStore.getState().setChats([makeChat({ headMessageId: 'variant-b' })]);
    mockedSetHead.mockResolvedValue(makeChat({ headMessageId: 'variant-a' }));

    const user = userEvent.setup();
    render(<ThreadForChat chatId="chat-1" />);

    await user.click(screen.getByLabelText('Previous variant'));

    await waitFor(() => expect(mockedSetHead).toHaveBeenCalledWith('chat-1', 'variant-a'));
    expect(useGruntStore.getState().chats[0]?.headMessageId).toBe('variant-a');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
