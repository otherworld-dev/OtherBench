import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';

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

import { useGruntStore } from './store.js';
import { useChatSync } from './useChatSync.js';

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return {
    id, title: 'New Chat', profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-pc', workspaceRoot: null, pinned: false, projectPinned: false, archivedAt: null, autoMode: false,
    projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('useChatSync', () => {
  beforeEach(() => {
    useGruntStore.setState(useGruntStore.getInitialState(), true);
    streams.length = 0;
  });

  it("reopens the chat's stream when the machine it runs on changes", () => {
    useGruntStore.setState({ chats: [chat('c1')] });
    renderHook(() => useChatSync('c1'));
    expect(streams).toEqual([{ url: '/api/chats/c1/stream', closed: false }]);

    // The server picks the machine to stream from when the stream opens.
    act(() => useGruntStore.getState().upsertChat(chat('c1', { runsOn: 'node-laptop' })));
    expect(streams).toEqual([
      { url: '/api/chats/c1/stream', closed: true },
      { url: '/api/chats/c1/stream', closed: false },
    ]);

    // Anything else about the chat changing leaves the stream alone.
    act(() => useGruntStore.getState().upsertChat(chat('c1', { runsOn: 'node-laptop', title: 'Renamed' })));
    expect(streams).toHaveLength(2);
  });
});
