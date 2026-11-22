import { act, cleanup, render, screen, within } from '@testing-library/react';
import { Profiler, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';

/** How many times each message has been drawn, by id. */
const drawn = vi.hoisted(() => new Map<string, number>());

vi.mock('../viewer/ViewerPanel.js', () => ({ ViewerPanel: () => null }));
vi.mock('../code/GitBar.js', () => ({ GitBar: () => null }));
vi.mock('../state/api.js', () => ({
  api: {
    claude: { planUsage: vi.fn(async () => ({ usage: null })), accounts: { list: vi.fn(async () => ({ accounts: [] })) } },
    turns: { setHead: vi.fn(), retry: vi.fn(), regenerate: vi.fn(), create: vi.fn(), cancel: vi.fn(async () => {}) },
    chats: { patch: vi.fn(), stop: vi.fn(async () => ({ stopped: [] })), stopComputer: vi.fn(async () => {}) },
    attachments: { upload: vi.fn(), list: vi.fn(), delete: vi.fn(), contentUrl: (id: string) => id, previewable: () => false },
    approvals: { resolve: vi.fn() },
    asks: { answer: vi.fn() },
  },
  ApiError: class ApiError extends Error {},
}));
// The real Message, counted: what Thread hands it decides whether it is drawn again.
vi.mock('../components/Message.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/Message.js')>();
  const Real = actual.Message;
  function Message(props: Parameters<typeof Real>[0]): JSX.Element {
    drawn.set(props.message.id, (drawn.get(props.message.id) ?? 0) + 1);
    return <Real {...props} />;
  }
  return { ...actual, Message };
});

import { useOtherBenchStore } from '../state/store.js';
import { Thread } from './Thread.js';

function makeChat(id: string, headMessageId: string): Chat {
  return {
    id, title: `Chat ${id}`, profileId: 'p1', headMessageId, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false,
    autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, archivedAt: null, createdAt: 1, updatedAt: 1,
  };
}

function message(id: string, chatId: string, parentId: string | null, over: Partial<CanonMessage> = {}): CanonMessage {
  const role = over.role ?? 'user';
  return {
    id, chatId, parentId, role, parts: [{ type: 'text', text: `text of ${id}` }], status: 'complete', error: null, createdAt: 0,
    producedBy: role === 'assistant' ? { profileId: 'p1', profileName: 'Profile', connectionId: 'c1', modelId: 'model-x' } : null,
    ...over,
  };
}

function ThreadForChat({ chatId }: { chatId: string }): JSX.Element {
  const chat = useOtherBenchStore((s) => s.chats.find((c) => c.id === chatId) ?? null);
  return <Thread chat={chat} />;
}

describe('what a stream chunk draws again', () => {
  beforeEach(() => {
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    useOtherBenchStore.setState({ chats: [makeChat('one', 'a1'), makeChat('two', 'r2')] });
    useOtherBenchStore.getState().loadMessages(
      'one',
      [message('u1', 'one', null), message('a1', 'one', 'u1', { role: 'assistant', status: 'streaming' })],
      null
    );
    useOtherBenchStore.getState().loadMessages(
      'two',
      [message('u2', 'two', null), message('r2', 'two', 'u2', { role: 'assistant', status: 'streaming', parts: [] })],
      null
    );
    drawn.clear();
  });
  afterEach(cleanup);

  it("nothing of a thread, while another chat's reply streams", () => {
    let commits = 0;
    render(
      <Profiler id="thread-one" onRender={() => void (commits += 1)}>
        <ThreadForChat chatId="one" />
      </Profiler>
    );
    expect(within(screen.getByTestId('thread-scroll')).getByText('text of a1')).toBeInTheDocument();
    commits = 0;
    drawn.clear();

    const { applyTurnEvent } = useOtherBenchStore.getState();
    act(() => {
      // Text, a tool call and its result, usage (the reply's extras), and an event for a reply not loaded here yet.
      for (const word of ['the ', 'other ', 'chat ', 'is ', 'busy']) applyTurnEvent({ messageId: 'r2', type: 'text-delta', text: word });
      applyTurnEvent({ messageId: 'r2', type: 'tool-call', id: 't1', name: 'read_file', args: { path: 'a.txt' } });
      applyTurnEvent({ messageId: 'r2', type: 'tool-result', id: 't1', name: 'read_file', result: 'ok', isError: false });
      applyTurnEvent({ messageId: 'r2', type: 'thinking', since: 5 });
      applyTurnEvent({ messageId: 'not-loaded', type: 'text-delta', text: 'early' });
    });
    expect(useOtherBenchStore.getState().messages['r2']?.parts).toHaveLength(3);
    // Not the thread, its header, its message box or any message in it.
    expect(commits).toBe(0);
    expect(drawn.size).toBe(0);

    // Its own reply still draws as it streams.
    act(() => applyTurnEvent({ messageId: 'a1', type: 'text-delta', text: ' and more' }));
    expect(commits).toBeGreaterThan(0);
    expect(within(screen.getByTestId('thread-scroll')).getByText('text of a1 and more')).toBeInTheDocument();
  });

  it('only the reply being written, not the messages above it', () => {
    render(<ThreadForChat chatId="one" />);
    drawn.clear();
    act(() => useOtherBenchStore.getState().applyTurnEvent({ messageId: 'a1', type: 'text-delta', text: ' and more' }));
    expect(drawn.get('a1')).toBe(1);
    expect(drawn.has('u1')).toBe(false);
  });

  it('Message itself skips a draw when handed the same things (a memo)', async () => {
    const actual = await vi.importActual<typeof import('../components/Message.js')>('../components/Message.js');
    expect((actual.Message as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });
});
