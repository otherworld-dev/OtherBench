import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { useGruntStore } from '../state/store.js';
import { Thread } from './Thread.js';
import { useViewerStore, viewerFor } from '../viewer/state.js';

vi.mock('../viewer/ViewerPanel.js', () => ({ ViewerPanel: () => <aside aria-label="Viewer" /> }));

vi.mock('../state/api.js', () => ({
  api: {
    claude: { planUsage: vi.fn(async () => ({ usage: null })) },
    turns: {
      setHead: vi.fn(),
      retry: vi.fn(),
      regenerate: vi.fn(),
      create: vi.fn(),
    },
    chats: { patch: vi.fn() },
    attachments: { upload: vi.fn(), list: vi.fn(), delete: vi.fn(), contentUrl: (id: string) => id, previewable: () => false },
    approvals: { resolve: vi.fn() },
  },
  ApiError: class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { api, ApiError } from '../state/api.js';

const mockedSetHead = vi.mocked(api.turns.setHead);
const mockedRetry = vi.mocked(api.turns.retry);
const mockedRegenerate = vi.mocked(api.turns.regenerate);
const mockedCreate = vi.mocked(api.turns.create);

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    title: 'Chat 1',
    profileId: 'p1',
    headMessageId: null,
    workspace: null,
    runsOn: 'node-self',
    workspaceRoot: null,
    pinned: false,
    autoMode: false,
    projectId: null,
    memoryCursor: null,
    memoryExcluded: false,
    sortOrder: 0,
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
  mockedRegenerate.mockReset();
  mockedCreate.mockReset();
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

  it('shows and hides the viewer beside the chat, remembered per chat', async () => {
    useViewerStore.setState({ viewers: {} });
    useGruntStore.setState({ chats: [makeChat()] });
    render(<ThreadForChat chatId="chat-1" />);
    const user = userEvent.setup();
    expect(screen.queryByRole('complementary', { name: 'Viewer' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Viewer' }));
    expect(screen.getByRole('complementary', { name: 'Viewer' })).toBeInTheDocument();
    expect(viewerFor(useViewerStore.getState().viewers, 'chat-1').open).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Viewer' }));
    expect(screen.queryByRole('complementary', { name: 'Viewer' })).toBeNull();
  });

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

    expect(within(screen.getByTestId('thread-scroll')).getByText('text of root-a')).toBeInTheDocument();
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

  it('follows a streamed delta appended to an existing message while near the bottom', () => {
    const scroller = setup();
    addReply('r1', 'hel');
    stubScroller(scroller, 600); // at the bottom
    fireEvent.scroll(scroller);
    scroller.scrollTop = 600;
    act(() => {
      useGruntStore.getState().loadMessages('chat-1', [variantMessage('r1', 'root', { status: 'streaming', parts: [{ type: 'text', text: 'hello world' }] })], null);
    });
    expect(scroller.scrollTop).toBe(1000);
  });

  it('follows when only extras change (a pending approval card appears) while near the bottom', () => {
    const scroller = setup();
    addReply('r1', 'running');
    stubScroller(scroller, 590);
    fireEvent.scroll(scroller);
    act(() => {
      useGruntStore.setState((st) => ({
        extras: {
          ...st.extras,
          r1: {
            usage: null,
            ...st.extras['r1'],
            pendingApprovals: [{ id: 'req-1', chatId: 'chat-1', messageId: 'r1', toolName: 'run_command', risk: 'execute', source: 'shell', args: {}, summary: 'npm test' }],
          },
        },
      }));
    });
    expect(scroller.scrollTop).toBe(1000);
  });

  it('opens a chat at the bottom', () => {
    const scrollHeight = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
    const tops = new WeakMap<Element, number>();
    const top = vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
      return tops.get(this) ?? 0;
    });
    const topSet = vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, v: number) {
      tops.set(this, v);
    });
    try {
      useGruntStore.getState().loadMessages('chat-1', [makeMessage('root', 'chat-1')], null);
      render(<Thread chat={makeChat({ headMessageId: 'root' })} />);
      expect(screen.getByTestId('thread-scroll').scrollTop).toBe(1000);
    } finally {
      scrollHeight.mockRestore();
      top.mockRestore();
      topSet.mockRestore();
    }
  });
});

describe('Thread composer per chat', () => {
  afterEach(cleanup);

  it('does not carry the Auto save state or profile selection from one chat to the next', async () => {
    useGruntStore.setState(useGruntStore.getInitialState(), true);
    const conn = { id: 'cc', name: 'cc', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null } as never;
    const oll = { id: 'oll', name: 'oll', kind: 'ollama', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null } as never;
    useGruntStore.getState().setConnections([conn, oll]);
    const prof = (id: string, connectionId: string) => ({
      id, name: id, description: null, colour: null, connectionId, modelId: 'm', systemPrompt: null, params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null,
    }) as never;
    useGruntStore.getState().setProfiles([prof('ccp', 'cc'), prof('ollp', 'oll')]);
    const a = makeChat({ id: 'a', profileId: 'ccp', workspaceRoot: '/ws' });
    const b = makeChat({ id: 'b', profileId: 'ccp', workspaceRoot: '/ws' });
    const c = makeChat({ id: 'c', profileId: 'ollp' });
    useGruntStore.getState().setChats([a, b, c]);
    vi.mocked(api.chats.patch).mockReturnValue(new Promise<Chat>(() => {}));
    const view = render(<Thread chat={a} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Auto mode' }));
    expect(screen.getByRole('button', { name: 'Auto mode' })).toBeDisabled();
    view.rerender(<Thread chat={b} />);
    expect(screen.getByRole('button', { name: 'Auto mode' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.rerender(<Thread chat={c} />);
    expect(screen.queryByRole('button', { name: 'Auto mode' })).not.toBeInTheDocument();
  });

  it('renders the pane header above (outside) the scroller, before and after the first message', () => {
    const view = render(<Thread chat={makeChat({ id: 'chat-a', headMessageId: null })} />);
    expect(screen.getByRole('region', { name: 'Conversation' })).not.toHaveTextContent('prompt');
    useGruntStore.getState().loadMessages('chat-a', [makeMessage('root-a', 'chat-a')], null);
    view.rerender(<Thread chat={makeChat({ id: 'chat-a', headMessageId: 'root-a' })} />);
    const strip = screen.getByRole('region', { name: 'Conversation' });
    const scroller = screen.getByTestId('thread-scroll');
    expect(scroller.contains(strip)).toBe(false);
    expect(strip.compareDocumentPosition(scroller) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('re-pins to the bottom when the scroller resizes while following, but not when scrolled up', () => {
    let trigger: () => void = () => undefined;
    class FakeRO {
      constructor(cb: () => void) { trigger = cb; }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeRO);
    try {
      useGruntStore.getState().loadMessages('chat-a', [makeMessage('root-a', 'chat-a')], null);
      render(<Thread chat={makeChat({ id: 'chat-a', headMessageId: 'root-a' })} />);
      const scroller = screen.getByTestId('thread-scroll');
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
      scroller.scrollTop = 600; // at the bottom
      fireEvent.scroll(scroller);
      scroller.scrollTop = 500; // simulate the shrink leaving the view short of the bottom
      trigger();
      expect(scroller.scrollTop).toBe(1000);
      scroller.scrollTop = 100; // user scrolls up
      fireEvent.scroll(scroller);
      trigger();
      expect(scroller.scrollTop).toBe(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Thread approval prompts that were discarded server-side', () => {
  beforeEach(reset);
  afterEach(cleanup);

  function setup(): void {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    const reply = variantMessage('reply', 'root', { status: 'streaming' });
    useGruntStore.getState().loadMessages('chat-1', [root, reply], null);
    useGruntStore.getState().applyTurnEvent({
      messageId: 'reply',
      type: 'approval-request',
      request: { id: 'req-1', chatId: 'chat-1', messageId: 'reply', toolName: 'write_file', risk: 'mutate', source: 'fs', args: { path: 'a.txt' }, summary: 'write_file(a.txt)' },
    });
  }

  it('drops the prompt when the server says the request is gone (404), instead of leaving a dead card with a retry error', async () => {
    setup();
    vi.mocked(api.approvals.resolve).mockRejectedValue(new ApiError(404, 'unknown or already resolved'));
    render(<Thread chat={makeChat({ headMessageId: 'reply' })} />);
    expect(screen.getByTestId('approval-prompt-req-1')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('approval-deny'));

    await waitFor(() => expect(screen.queryByTestId('approval-prompt-req-1')).not.toBeInTheDocument());
  });

  it('keeps the prompt (and lets the user retry) on any other failure', async () => {
    setup();
    vi.mocked(api.approvals.resolve).mockRejectedValue(new ApiError(500, 'boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Thread chat={makeChat({ headMessageId: 'reply' })} />);

    await userEvent.click(screen.getByTestId('approval-deny'));

    await screen.findByText(/Could not send that decision/);
    expect(screen.getByTestId('approval-prompt-req-1')).toBeInTheDocument();
  });

  it('removes the prompt when the variant is cancelled (terminal status arrives)', () => {
    setup();
    render(<Thread chat={makeChat({ headMessageId: 'reply' })} />);
    expect(screen.getByTestId('approval-prompt-req-1')).toBeInTheDocument();
    act(() => useGruntStore.getState().applyTurnEvent({ messageId: 'reply', type: 'status', status: 'cancelled' }));
    expect(screen.queryByTestId('approval-prompt-req-1')).not.toBeInTheDocument();
  });
});

describe('Thread error mid-step', () => {
  beforeEach(reset);
  afterEach(cleanup);

  it('keeps the approval card and the Stop button while the server is still streaming after an error event, and drops the card on the terminal status', () => {
    const root = makeMessage('root', 'chat-1', { role: 'user' });
    const reply = variantMessage('reply', 'root', { status: 'streaming' });
    useGruntStore.getState().loadMessages('chat-1', [root, reply], null);
    const chat = makeChat({ headMessageId: 'reply' });
    render(<Thread chat={chat} />);
    act(() => {
      useGruntStore.getState().applyTurnEvent({
        messageId: 'reply',
        type: 'approval-request',
        request: { id: 'req-1', chatId: 'chat-1', messageId: 'reply', toolName: 'write_file', risk: 'mutate', source: 'fs', args: {}, summary: 'write_file(a.txt)' },
      });
      useGruntStore.getState().applyTurnEvent({ messageId: 'reply', type: 'error', error: { kind: 'rate_limit', message: 'overloaded', retryable: true } });
    });

    expect(screen.getByTestId('approval-prompt-req-1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();

    act(() => useGruntStore.getState().applyTurnEvent({ messageId: 'reply', type: 'status', status: 'error' }));
    expect(screen.queryByTestId('approval-prompt-req-1')).not.toBeInTheDocument();
  });
});

describe('Thread regenerate, edit and branch switching', () => {
  beforeEach(reset);
  afterEach(cleanup);

  const asst = (id: string, parentId: string, createdAt: number, extra: Partial<CanonMessage> = {}): CanonMessage =>
    variantMessage(id, parentId, {
      createdAt,
      parts: [{ type: 'text', text: `reply ${id}` }],
      producedBy: { profileId: 'p1', profileName: 'Default', connectionId: 'c1', modelId: 'model-x', ...(extra.producedBy ?? {}) },
      ...extra,
    });
  const usr = (id: string, parentId: string | null, createdAt: number, text = `text of ${id}`): CanonMessage =>
    makeMessage(id, 'chat-1', { role: 'user', parentId, createdAt, parts: [{ type: 'text', text }] });
  const load = (...ms: CanonMessage[]): void => useGruntStore.getState().loadMessages('chat-1', ms, null);
  const regen = { regenerated: true, profileId: 'p1', profileName: 'Default', connectionId: 'c1', modelId: 'model-x' };

  function seedProfile(): void {
    useGruntStore.getState().setProfiles([
      {
        id: 'p1', name: 'Default', description: null, colour: null, connectionId: 'c1', modelId: 'model-x', systemPrompt: null,
        params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: true, archivedAt: null,
      },
    ]);
  }

  function mount(headMessageId: string) {
    useGruntStore.getState().setChats([makeChat({ headMessageId })]);
    return render(<ThreadForChat chatId="chat-1" />);
  }

  it('Regenerate calls the endpoint for that reply, registers the new reply and makes it the active branch', async () => {
    load(usr('u1', null, 1), asst('a1', 'u1', 2));
    mockedRegenerate.mockResolvedValue({ userMessageId: 'u1', assistantMessageId: 'a2' });
    mount('u1');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Regenerate' }));

    await waitFor(() => expect(mockedRegenerate).toHaveBeenCalledWith('chat-1', 'a1'));
    await waitFor(() => expect(useGruntStore.getState().chats[0]?.headMessageId).toBe('a2'));
    expect(useGruntStore.getState().messages['a2']).toMatchObject({ parentId: 'u1', role: 'assistant', status: 'streaming' });
    expect(useGruntStore.getState().messages['a2']?.producedBy).toMatchObject({ profileId: 'p1', regenerated: true });
    // No compare tab strip -- a regenerated pair is browsed with the switcher.
    expect(screen.queryByTestId('variant-tabs')).not.toBeInTheDocument();
    expect(screen.getByTestId('branch-switcher')).toHaveTextContent('2 / 2');
  });

  it('shows the error and leaves the thread alone when regenerate is rejected', async () => {
    load(usr('u1', null, 1), asst('a1', 'u1', 2));
    mockedRegenerate.mockRejectedValue(new Error('nope'));
    mount('u1');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/regenerate/i);
    expect(useGruntStore.getState().chats[0]?.headMessageId).toBe('u1');
  });

  it('switches branches: the thread shows that branch down to its tip and head moves there', async () => {
    // u1 -> a1 ; u1 -> a2 (regenerated) -> u2 -> a3
    load(usr('u1', null, 1), asst('a1', 'u1', 2), asst('a2', 'u1', 3, { producedBy: regen }), usr('u2', 'a2', 4), asst('a3', 'u2', 5));
    mockedSetHead.mockResolvedValue(makeChat());
    mount('a3');
    const user = userEvent.setup();
    expect(screen.getByText('reply a3')).toBeInTheDocument();
    expect(screen.queryByText('reply a1')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Previous branch' }));
    await waitFor(() => expect(mockedSetHead).toHaveBeenCalledWith('chat-1', 'a1'));
    expect(screen.getByText('reply a1')).toBeInTheDocument();
    expect(screen.queryByText('reply a3')).not.toBeInTheDocument();
    expect(screen.queryByText('text of u2')).not.toBeInTheDocument();

    // And back: the tip of the regenerated branch is the last message below it.
    await user.click(screen.getByRole('button', { name: 'Next branch' }));
    await waitFor(() => expect(mockedSetHead).toHaveBeenLastCalledWith('chat-1', 'a3'));
    expect(screen.getByText('reply a3')).toBeInTheDocument();
  });

  it('displays a branch whose head is still on its user message down through a regenerated pair without opening compare tabs', () => {
    load(usr('u1', null, 1), asst('a1', 'u1', 2), asst('a2', 'u1', 3, { producedBy: regen }));
    mount('u1');
    expect(screen.queryByTestId('variant-tabs')).not.toBeInTheDocument();
    expect(screen.getByText('reply a2')).toBeInTheDocument();
  });

  it('rolls the switch back when the server rejects the new head', async () => {
    load(usr('u1', null, 1), asst('a1', 'u1', 2), asst('a2', 'u1', 3, { producedBy: regen }));
    mockedSetHead.mockRejectedValue(new Error('refused'));
    mount('a2');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous branch' }));
    await waitFor(() => expect(useGruntStore.getState().chats[0]?.headMessageId).toBe('a2'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('Edit opens the message inline; saving posts a sibling user message under the same parent with the chat profile, and moves head to it', async () => {
    seedProfile();
    load(usr('u1', null, 1, 'first'), asst('a1', 'u1', 2), usr('u2', 'a1', 3, 'second'), asst('a2', 'u2', 4));
    useGruntStore.getState().setChats([makeChat({ headMessageId: 'a2' })]);
    mockedCreate.mockResolvedValue({ userMessageId: 'u2b', assistantMessageIds: ['a2b'] });
    mockedSetHead.mockResolvedValue(makeChat());
    render(<ThreadForChat chatId="chat-1" />);
    const user = userEvent.setup();

    const editButtons = screen.getAllByRole('button', { name: 'Edit' });
    await user.click(editButtons[1]!); // the second user message
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    expect(box).toHaveValue('second');
    await user.clear(box);
    await user.type(box, 'second, reworded');
    await user.click(screen.getByRole('button', { name: 'Save and send' }));

    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith('chat-1', { parentId: 'a1', parts: [{ type: 'text', text: 'second, reworded' }], profileIds: ['p1'] })
    );
    await waitFor(() => expect(useGruntStore.getState().chats[0]?.headMessageId).toBe('u2b'));
    expect(useGruntStore.getState().messages['u2b']).toMatchObject({ parentId: 'a1', role: 'user' });
    expect(useGruntStore.getState().messages['a2b']).toMatchObject({ parentId: 'u2b', role: 'assistant' });
    // The original is still in the tree, reachable by the switcher on the edited message.
    expect(useGruntStore.getState().messages['u2']).toBeDefined();
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument());
    expect(within(screen.getByTestId('thread-scroll')).getByText('second, reworded')).toBeInTheDocument();
    const switchers = screen.getAllByTestId('branch-switcher');
    expect(switchers[0]).toHaveTextContent('2 / 2');
    expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument();
  });

  it('Cancel closes the editor without sending anything', async () => {
    seedProfile();
    load(usr('u1', null, 1), asst('a1', 'u1', 2));
    mount('a1');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Edit message' })).not.toBeInTheDocument();
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('editing the FIRST message makes a sibling root, switchable', async () => {
    seedProfile();
    load(usr('u1', null, 1, 'hello'), asst('a1', 'u1', 2));
    mockedCreate.mockResolvedValue({ userMessageId: 'u1b', assistantMessageIds: ['a1b'] });
    mockedSetHead.mockResolvedValue(makeChat());
    mount('a1');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByRole('textbox', { name: 'Edit message' }));
    await user.type(screen.getByRole('textbox', { name: 'Edit message' }), 'hello there');
    await user.click(screen.getByRole('button', { name: 'Save and send' }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith('chat-1', expect.objectContaining({ parentId: null })));
    await waitFor(() => expect(screen.getByTestId('branch-switcher')).toHaveTextContent('2 / 2'));
  });

  it('disables Regenerate and Edit while any reply in the chat is streaming', () => {
    load(usr('u1', null, 1), asst('a1', 'u1', 2), usr('u2', 'a1', 3), asst('a2', 'u2', 4, { status: 'streaming', parts: [] }));
    mount('u2');
    for (const b of screen.getAllByRole('button', { name: 'Edit' })) expect(b).toBeDisabled();
    for (const b of screen.getAllByRole('button', { name: 'Regenerate' })) expect(b).toBeDisabled();
  });

  it('does not offer Regenerate or the branch switcher inside a compare turn, which keeps its tabs', () => {
    load(usr('u1', null, 1), asst('x', 'u1', 2), asst('y', 'u1', 2));
    mount('u1');
    expect(screen.getByTestId('variant-tabs')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-switcher')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
  });

  it('a resolved compare turn still shows its chip, not a switcher or Regenerate', () => {
    load(usr('u1', null, 1), asst('x', 'u1', 2), asst('y', 'u1', 2));
    mount('x');
    expect(screen.getByTestId('reopen-variants-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-switcher')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
  });

  const twoProfiles = (): void =>
    useGruntStore.getState().setProfiles(
      ['p1', 'p2'].map((id) => ({
        id, name: `Profile ${id}`, description: null, colour: null, connectionId: 'c1', modelId: 'model-x', systemPrompt: null,
        params: {}, toolPolicy: { fs: 'off' as const, shell: false, mcpServerIds: [], approvalMode: 'always_ask' as const }, isDefault: false, archivedAt: null,
      }))
    );

  it('switching branches and then SENDING parents the new message on the switched branch tip, through a resolved compare turn', async () => {
    seedProfile();
    // u1 -> a1 ; u1 -> a1r (regenerated, newest).  a1 -> u2 -> {A, B(kept)} ; B -> u3 -> a3
    load(
      usr('u1', null, 1, 'k1'), asst('a1', 'u1', 2), asst('a1r', 'u1', 9, { producedBy: regen }),
      usr('u2', 'a1', 3, 'k2'), asst('A', 'u2', 4), asst('B', 'u2', 4), usr('u3', 'B', 5, 'k3'), asst('a3', 'u3', 6)
    );
    mockedSetHead.mockResolvedValue(makeChat());
    mockedCreate.mockResolvedValue({ userMessageId: 'u4', assistantMessageIds: ['a4'] });
    mount('a1r');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Previous branch' }));
    await waitFor(() => expect(mockedSetHead).toHaveBeenCalledWith('chat-1', 'a3'));
    const scroll = within(screen.getByTestId('thread-scroll'));
    expect(scroll.getByText('k3')).toBeInTheDocument();
    expect(screen.queryByTestId('variant-tabs')).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'k4{Enter}');
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith('chat-1', expect.objectContaining({ parentId: 'a3' })));
  });

  it('switching to a branch ending in an unresolved compare turn leaves the tabs open', async () => {
    seedProfile();
    load(usr('u1', null, 1), asst('a1', 'u1', 2), asst('a1r', 'u1', 9, { producedBy: regen }), usr('u2', 'a1', 3), asst('A', 'u2', 4), asst('B', 'u2', 4));
    mockedSetHead.mockResolvedValue(makeChat());
    mount('a1r');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous branch' }));
    await waitFor(() => expect(mockedSetHead).toHaveBeenCalledWith('chat-1', 'u2'));
    expect(screen.getByTestId('variant-tabs')).toBeInTheDocument();
  });

  it('Edit answers with the profile that answered the original reply, not chat.profileId, and says so', async () => {
    twoProfiles();
    load(usr('u1', null, 1), asst('a1', 'u1', 2, { producedBy: { profileId: 'p2', profileName: 'Profile p2', connectionId: 'c1', modelId: 'model-x' } }));
    mockedCreate.mockResolvedValue({ userMessageId: 'u1b', assistantMessageIds: ['a1b'] });
    mockedSetHead.mockResolvedValue(makeChat());
    mount('a1');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('edit-profile-note')).toHaveTextContent('Profile p2');
    await user.type(screen.getByRole('textbox', { name: 'Edit message' }), ' more');
    await user.click(screen.getByRole('button', { name: 'Save and send' }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith('chat-1', expect.objectContaining({ profileIds: ['p2'] })));
  });

  it('Edit with no reply to go by uses the composer picker selection before chat.profileId', async () => {
    twoProfiles();
    load(usr('u1', null, 1));
    mockedCreate.mockResolvedValue({ userMessageId: 'u1b', assistantMessageIds: ['a1b'] });
    mockedSetHead.mockResolvedValue(makeChat());
    mount('u1');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Profile p1/ }));
    await user.click(screen.getByRole('option', { name: /Profile p2/ }));
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('edit-profile-note')).toHaveTextContent('Profile p2');
    await user.type(screen.getByRole('textbox', { name: 'Edit message' }), '!');
    await user.click(screen.getByRole('button', { name: 'Save and send' }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith('chat-1', expect.objectContaining({ profileIds: ['p2'] })));
  });

  it('editing a compare prompt says the edit goes to one profile only', async () => {
    seedProfile();
    load(usr('u1', null, 1), asst('x', 'u1', 2), asst('y', 'u1', 2));
    mount('x');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('edit-profile-note')).toHaveTextContent(/one profile/i);
  });

  it('disables the branch switcher while a reply streams', () => {
    seedProfile();
    load(usr('u1', null, 1), asst('a1', 'u1', 2), asst('a1r', 'u1', 3, { producedBy: regen }), usr('u2', 'a1r', 4), asst('a2', 'u2', 5, { status: 'streaming', parts: [] }));
    mount('u2');
    expect(screen.getByRole('button', { name: 'Previous branch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next branch' })).toBeDisabled();
  });

  it('announces a branch switch politely', async () => {
    load(usr('u1', null, 1), asst('a1', 'u1', 2), asst('a2', 'u1', 3, { producedBy: regen }));
    mockedSetHead.mockResolvedValue(makeChat());
    mount('a2');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous branch' }));
    const live = await screen.findByTestId('branch-announcer');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Branch 1 of 2');
  });

  it('editing a compare prompt after keeping B answers with the KEPT variant\'s profile', async () => {
    twoProfiles();
    const by = (id: string) => ({ profileId: id, profileName: `Profile ${id}`, connectionId: 'c1', modelId: 'model-x' });
    load(usr('u1', null, 1), asst('A', 'u1', 2, { producedBy: by('p1') }), asst('B', 'u1', 2, { producedBy: by('p2') }));
    mockedCreate.mockResolvedValue({ userMessageId: 'u1b', assistantMessageIds: ['a1b'] });
    mockedSetHead.mockResolvedValue(makeChat());
    mount('B'); // B is the kept variant
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('edit-profile-note')).toHaveTextContent('Profile p2');
    await user.type(screen.getByRole('textbox', { name: 'Edit message' }), '!');
    await user.click(screen.getByRole('button', { name: 'Save and send' }));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith('chat-1', expect.objectContaining({ profileIds: ['p2'] })));
  });

  it('does not announce a branch switch the server refused', async () => {
    load(usr('u1', null, 1), asst('a1', 'u1', 2), asst('a2', 'u1', 3, { producedBy: regen }));
    mockedSetHead.mockRejectedValue(new Error('refused'));
    mount('a2');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous branch' }));
    await screen.findByRole('alert');
    expect(screen.getByTestId('branch-announcer')).toHaveTextContent('');
  });

  it('a repeated identical announcement still changes the live region content', async () => {
    // Two forks, both "2 / 2": switching each to "1 / 2" in a row announces the same words twice.
    load(
      usr('u1', null, 1), asst('a1', 'u1', 2), asst('a2', 'u1', 3, { producedBy: regen }),
      usr('u2', 'a2', 4), asst('a3', 'u2', 5), asst('a3r', 'u2', 6, { producedBy: regen })
    );
    mockedSetHead.mockResolvedValue(makeChat());
    mount('a3r');
    const user = userEvent.setup();
    const switchers = screen.getAllByTestId('branch-switcher'); // [fork at a2, fork at a3r]
    await user.click(within(switchers[1]!).getByRole('button', { name: 'Previous branch' }));
    await waitFor(() => expect(screen.getByTestId('branch-announcer')).toHaveTextContent('Branch 1 of 2'));
    const first = screen.getByTestId('branch-announcer').textContent;
    await user.click(within(screen.getAllByTestId('branch-switcher')[0]!).getByRole('button', { name: 'Previous branch' }));
    await waitFor(() => expect(screen.getByTestId('branch-announcer').textContent).not.toBe(first));
    expect(screen.getByTestId('branch-announcer')).toHaveTextContent('Branch 1 of 2');
  });

  const by = (name: string) => ({ producedBy: { profileId: 'p1', profileName: name, connectionId: 'c1', modelId: 'model-x' } });

  it('sending while compare tabs are open continues from the tab showing, and says so', async () => {
    seedProfile();
    load(usr('u1', null, 1), asst('A', 'u1', 2, by('Alpha')), asst('B', 'u1', 2, by('Beta')));
    mockedCreate.mockResolvedValue({ userMessageId: 'u2', assistantMessageIds: ['a2'] });
    mockedSetHead.mockResolvedValue(makeChat());
    mount('u1');
    const user = userEvent.setup();

    expect(screen.getByText(/continues from Alpha's reply/)).toBeInTheDocument();
    await user.click(screen.getByTestId('variant-tab-B'));
    expect(screen.getByText(/continues from Beta's reply/)).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'next{Enter}');
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith('chat-1', expect.objectContaining({ parentId: 'B' })));
  });

  it('shows no continue hint once a variant is kept', () => {
    seedProfile();
    load(usr('u1', null, 1), asst('A', 'u1', 2, by('Alpha')), asst('B', 'u1', 2, by('Beta')));
    mount('B');
    expect(screen.queryByText(/continues from/)).not.toBeInTheDocument();
  });

  it('a variant kept but never continued stays kept after switching branches away and back', async () => {
    seedProfile();
    // u1 -> {a1, a1r (regenerated)} ; a1 -> u2 -> {A, B}
    load(usr('u1', null, 1), asst('a1', 'u1', 2), asst('a1r', 'u1', 9, { producedBy: regen }), usr('u2', 'a1', 3), asst('A', 'u2', 4), asst('B', 'u2', 4));
    mockedSetHead.mockResolvedValue(makeChat());
    mount('u2');
    const user = userEvent.setup();

    await user.click(screen.getByTestId('variant-tab-B'));
    await user.click(screen.getByRole('button', { name: /keep this one/i }));
    await waitFor(() => expect(mockedSetHead).toHaveBeenCalledWith('chat-1', 'B'));

    await user.click(screen.getByRole('button', { name: 'Next branch' }));
    await waitFor(() => expect(mockedSetHead).toHaveBeenLastCalledWith('chat-1', 'a1r'));
    await user.click(screen.getByRole('button', { name: 'Previous branch' }));
    await waitFor(() => expect(mockedSetHead).toHaveBeenLastCalledWith('chat-1', 'B'));
    expect(screen.queryByTestId('variant-tabs')).not.toBeInTheDocument();
    expect(screen.getByTestId('reopen-variants-chip')).toBeInTheDocument();
  });

  it('Edit skips an answering profile that has since been archived', async () => {
    useGruntStore.getState().setProfiles(
      ['p1', 'p2'].map((id) => ({
        id, name: `Profile ${id}`, description: null, colour: null, connectionId: 'c1', modelId: 'model-x', systemPrompt: null,
        params: {}, toolPolicy: { fs: 'off' as const, shell: false, mcpServerIds: [], approvalMode: 'always_ask' as const }, isDefault: false,
        archivedAt: id === 'p2' ? 5 : null,
      }))
    );
    load(usr('u1', null, 1), asst('a1', 'u1', 2, { producedBy: { profileId: 'p2', profileName: 'Profile p2', connectionId: 'c1', modelId: 'model-x' } }));
    mount('a1');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('edit-profile-note')).toHaveTextContent('Profile p1');
  });
});
