import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';

const streams = vi.hoisted(() => [] as { url: string; closed: boolean }[]);

vi.mock('./sse.js', () => ({
  SseClient: class {
    private readonly stream: { url: string; closed: boolean };
    constructor(opts: { url: string }) {
      this.stream = { url: opts.url, closed: false };
      streams.push(this.stream);
    }
    connect(): void {}
    close(): void {
      this.stream.closed = true;
    }
  },
}));

vi.mock('./api.js', () => ({
  api: {
    chats: { messages: vi.fn(async () => ({ messages: [], headMessageId: null, usage: {} })) },
    streamUrl: (chatId: string) => `/api/chats/${chatId}/stream`,
  },
}));

import { api } from './api.js';
import { KEPT_RECENT_CHATS } from './messagePool.js';
import { DEFAULT_PANE_STATE } from './panes.js';
import { useOtherBenchStore } from './store.js';
import { useChatSync } from './useChatSync.js';

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return {
    id, title: 'New Chat', profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-pc', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
    projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('useChatSync', () => {
  beforeEach(() => {
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    streams.length = 0;
  });
  // Unmounting lets go of each chat the hook followed, which the message pool keeps while followed.
  afterEach(cleanup);

  it("reopens the chat's stream when the machine it runs on changes", () => {
    useOtherBenchStore.setState({ chats: [chat('c1')] });
    renderHook(() => useChatSync('c1'));
    expect(streams).toEqual([{ url: '/api/chats/c1/stream', closed: false }]);

    // The server picks the machine to stream from when the stream opens.
    act(() => useOtherBenchStore.getState().upsertChat(chat('c1', { runsOn: 'node-laptop' })));
    expect(streams).toEqual([
      { url: '/api/chats/c1/stream', closed: true },
      { url: '/api/chats/c1/stream', closed: false },
    ]);

    // Anything else about the chat changing leaves the stream alone.
    act(() => useOtherBenchStore.getState().upsertChat(chat('c1', { runsOn: 'node-laptop', title: 'Renamed' })));
    expect(streams).toHaveLength(2);
  });

  it('loads a chat the message pool forgot again when it shows again', async () => {
    const message = (chatId: string): CanonMessage => ({
      id: `${chatId}-m`, chatId, parentId: null, role: 'user', parts: [{ type: 'text', text: chatId }], status: 'complete', error: null, producedBy: null, createdAt: 1,
    });
    const fetchMessages = vi.mocked(api.chats.messages);
    fetchMessages.mockImplementation(async (chatId: string) => ({ messages: [message(chatId)], headMessageId: `${chatId}-m`, usage: {} }));
    useOtherBenchStore.setState({ paneState: DEFAULT_PANE_STATE, activeChatId: null });
    const loaded = (chatId: string): boolean => `${chatId}-m` in useOtherBenchStore.getState().messages;
    // One pane, its thread following whichever chat is active.
    const { rerender } = renderHook(({ chatId }: { chatId: string | null }) => useChatSync(chatId), { initialProps: { chatId: null as string | null } });
    const show = async (chatId: string): Promise<void> => {
      act(() => useOtherBenchStore.getState().setActiveChatId(chatId));
      rerender({ chatId });
      await waitFor(() => expect(loaded(chatId)).toBe(true));
    };

    // The switch away from a chat happens while its thread still follows it, so it counts as in use for one more.
    for (let i = 0; i <= KEPT_RECENT_CHATS + 2; i++) await show(`c${i}`);
    expect(loaded('c0')).toBe(false);
    expect(loaded('c1')).toBe(true);

    fetchMessages.mockClear();
    await show('c0');
    expect(fetchMessages).toHaveBeenCalledWith('c0');
  });
});
