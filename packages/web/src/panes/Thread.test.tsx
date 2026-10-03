import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      retry: vi.fn(),
    },
  },
}));

import { api } from '../state/api.js';

const mockedSetHead = vi.mocked(api.turns.setHead);
const mockedRetry = vi.mocked(api.turns.retry);

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

function variantMessage(id: string, parentId: string, overrides: Partial<CanonMessage> = {}): CanonMessage {
  return makeMessage(id, 'chat-1', {
    parentId,
    role: 'assistant',
    producedBy: { profileId: id, profileName: `Profile ${id}`, connectionId: 'c1', modelId: 'model-x' },
    ...overrides,
  });
}

function reset(): void {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  mockedSetHead.mockReset();
  mockedRetry.mockReset();
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
  it('does not show a compare chip or tab strip on a chat whose root message merely shares parentId:null with other chats loaded in the same session', () => {
    const rootA = makeMessage('root-a', 'chat-a');
    const rootB = makeMessage('root-b', 'chat-b');
    const rootC = makeMessage('root-c', 'chat-c');

    useGruntStore.getState().loadMessages('chat-a', [rootA], null);
    useGruntStore.getState().loadMessages('chat-b', [rootB], null);
    useGruntStore.getState().loadMessages('chat-c', [rootC], null);

    const chatA = makeChat({ id: 'chat-a', headMessageId: 'root-a' });

    render(<Thread chat={chatA} />);

    expect(screen.getByText('text of root-a')).toBeInTheDocument();
    expect(screen.queryByTestId('reopen-variants-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('variant-tabs')).not.toBeInTheDocument();
  });

  it('renders an open tab strip for an unresolved compare turn (head still on the parent user message)', () => {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    const variantA = variantMessage('variant-a', 'root', { createdAt: 1, parts: [{ type: 'text', text: 'reply A' }] });
    const variantB = variantMessage('variant-b', 'root', { createdAt: 2, parts: [{ type: 'text', text: 'reply B' }] });
    useGruntStore.getState().loadMessages('chat-1', [root, variantA, variantB], null);
    // Head is on the USER message -- nothing has been kept yet.
    const chat = makeChat({ headMessageId: 'root' });

    render(<Thread chat={chat} />);

    expect(screen.getByTestId('variant-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('variant-tab-variant-a')).toBeInTheDocument();
    expect(screen.getByTestId('variant-tab-variant-b')).toBeInTheDocument();
    // Unresolved -- no chip anywhere, and no Collapse button (nothing to collapse back to).
    expect(screen.queryByTestId('reopen-variants-chip')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /collapse variants/i })).not.toBeInTheDocument();
  });

  it('a single-profile reply renders automatically even though head only advances to the user message', () => {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    const reply = variantMessage('reply', 'root', { createdAt: 1, parts: [{ type: 'text', text: 'the only reply' }] });
    useGruntStore.getState().loadMessages('chat-1', [root, reply], null);
    const chat = makeChat({ headMessageId: 'root' });

    render(<Thread chat={chat} />);

    expect(screen.getByText('the only reply')).toBeInTheDocument();
    expect(screen.queryByTestId('variant-tabs')).not.toBeInTheDocument();
  });

  it('a resolved compare turn (head already on one variant) renders as an ordinary message with a chip, which reopens the tab strip', async () => {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    const variantA = variantMessage('variant-a', 'root', { createdAt: 1, parts: [{ type: 'text', text: 'reply A' }] });
    const variantB = variantMessage('variant-b', 'root', { createdAt: 2, parts: [{ type: 'text', text: 'reply B' }] });
    useGruntStore.getState().loadMessages('chat-1', [root, variantA, variantB], null);
    const chat = makeChat({ headMessageId: 'variant-b' });

    const user = userEvent.setup();
    render(<Thread chat={chat} />);

    expect(screen.getByText('reply B')).toBeInTheDocument();
    expect(screen.queryByTestId('variant-tabs')).not.toBeInTheDocument();
    const chip = screen.getByTestId('reopen-variants-chip');
    expect(chip).toHaveTextContent('⤺ 1 other variant');

    await user.click(chip);

    const tabs = screen.getByTestId('variant-tabs');
    expect(within(tabs).getByTestId('variant-tab-variant-a')).toBeInTheDocument();
    expect(within(tabs).getByTestId('variant-tab-variant-b')).toBeInTheDocument();
    // Reopened (not fresh/unresolved) -- a Collapse button is offered.
    expect(screen.getByRole('button', { name: /collapse variants/i })).toBeInTheDocument();
  });

  it('Keep issues the head call and collapses the open tab strip back into an ordinary message', async () => {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    const variantA = variantMessage('variant-a', 'root', { createdAt: 1, parts: [{ type: 'text', text: 'reply A' }] });
    const variantB = variantMessage('variant-b', 'root', { createdAt: 2, parts: [{ type: 'text', text: 'reply B' }] });
    useGruntStore.getState().loadMessages('chat-1', [root, variantA, variantB], null);
    useGruntStore.getState().setChats([makeChat({ headMessageId: 'root' })]);
    mockedSetHead.mockResolvedValue(makeChat({ headMessageId: 'variant-b' }));

    const user = userEvent.setup();
    render(<ThreadForChat chatId="chat-1" />);

    expect(screen.getByTestId('variant-tabs')).toBeInTheDocument();
    await user.click(screen.getByTestId('variant-tab-variant-b'));
    await user.click(screen.getByRole('button', { name: /keep this one/i }));

    await waitFor(() => expect(mockedSetHead).toHaveBeenCalledWith('chat-1', 'variant-b'));
    // Collapsed: the tab strip is gone, replaced by the kept message + chip for the other variant.
    await waitFor(() => expect(screen.queryByTestId('variant-tabs')).not.toBeInTheDocument());
    expect(screen.getByText('reply B')).toBeInTheDocument();
    expect(screen.getByTestId('reopen-variants-chip')).toHaveTextContent('⤺ 1 other variant');
  });

  it('reverts the optimistic Keep and surfaces an error when the server rejects setHead', async () => {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    const variantA = variantMessage('variant-a', 'root', { createdAt: 1, parts: [{ type: 'text', text: 'reply A' }] });
    const variantB = variantMessage('variant-b', 'root', { createdAt: 2, parts: [{ type: 'text', text: 'reply B' }] });
    useGruntStore.getState().loadMessages('chat-1', [root, variantA, variantB], null);
    useGruntStore.getState().setChats([makeChat({ headMessageId: 'variant-b' })]);
    mockedSetHead.mockRejectedValue(new Error('Bad Request'));

    const user = userEvent.setup();
    render(<ThreadForChat chatId="chat-1" />);

    await user.click(screen.getByTestId('reopen-variants-chip'));
    await user.click(screen.getByTestId('variant-tab-variant-a'));
    await user.click(screen.getByRole('button', { name: /keep this one/i }));

    await waitFor(() => expect(mockedSetHead).toHaveBeenCalledWith('chat-1', 'variant-a'));
    // Reverted back to variant-b once the server rejected the switch.
    await waitFor(() => expect(useGruntStore.getState().chats[0]?.headMessageId).toBe('variant-b'));
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't keep|failed to keep/i);
  });

  it('Retry calls the retry endpoint for that variant only and resets it locally, leaving its sibling untouched', async () => {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    const failing = variantMessage('failing', 'root', {
      createdAt: 1,
      status: 'error',
      error: { kind: 'rate_limit', message: 'boom', retryable: true },
      parts: [{ type: 'text', text: 'partial before failing' }],
    });
    const healthy = variantMessage('healthy', 'root', { createdAt: 2, status: 'streaming', parts: [{ type: 'text', text: 'still going' }] });
    useGruntStore.getState().loadMessages('chat-1', [root, failing, healthy], null);
    mockedRetry.mockResolvedValue({ messageId: 'failing' });
    const chat = makeChat({ headMessageId: 'root' });

    const user = userEvent.setup();
    render(<Thread chat={chat} />);

    await user.click(screen.getByTestId('variant-tab-failing'));
    await user.click(screen.getByRole('button', { name: /retry profile failing/i }));

    expect(mockedRetry).toHaveBeenCalledWith('failing');
    // Reset locally: the failed attempt's stale content/error is cleared and status re-armed to streaming.
    await waitFor(() => expect(useGruntStore.getState().messages['failing']?.status).toBe('streaming'));
    expect(useGruntStore.getState().messages['failing']?.parts).toEqual([]);
    // The sibling is completely unaffected.
    expect(useGruntStore.getState().messages['healthy']?.parts).toEqual([{ type: 'text', text: 'still going' }]);
  });
});

describe('Thread auto-scroll', () => {
  beforeEach(reset);
  afterEach(cleanup);

  /** jsdom has no layout: give the scroll container fixed metrics and a plain writable scrollTop. */
  function stubScroller(el: HTMLElement, scrollTop: number): void {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: scrollTop });
  }

  function addReply(id: string, text: string): void {
    act(() => {
      useGruntStore.getState().loadMessages('chat-1', [variantMessage(id, 'root', { parts: [{ type: 'text', text }] })], null);
    });
  }

  function setup(): HTMLElement {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    useGruntStore.getState().loadMessages('chat-1', [root], null);
    render(<Thread chat={makeChat({ headMessageId: 'root' })} />);
    return screen.getByTestId('thread-scroll');
  }

  it('follows new content when the user is near the bottom', () => {
    const scroller = setup();
    stubScroller(scroller, 590); // 1000 - 590 - 400 = 10px from the bottom
    fireEvent.scroll(scroller);
    addReply('r1', 'hello');
    expect(scroller.scrollTop).toBe(1000);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });

  it('does not yank the view when the user has scrolled up, and offers a Jump to latest button', async () => {
    const scroller = setup();
    stubScroller(scroller, 100);
    fireEvent.scroll(scroller);
    addReply('r1', 'hello');
    expect(scroller.scrollTop).toBe(100);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(scroller.scrollTop).toBe(1000);
    // Following resumes: the scroll event the jump causes puts us back at the bottom.
    fireEvent.scroll(scroller);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    addReply('r2', 'again');
    expect(scroller.scrollTop).toBe(1000);
  });
});
