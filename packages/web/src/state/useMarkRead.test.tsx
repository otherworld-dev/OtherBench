import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';

vi.mock('./api.js', () => ({
  api: { chats: { patch: vi.fn() } },
}));

import { api } from './api.js';
import { DEFAULT_PANE_STATE } from './panes.js';
import { useOtherBenchStore } from './store.js';
import { useMarkRead } from './useMarkRead.js';

const mockedPatch = vi.mocked(api.chats.patch);

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return {
    id, title: 'New Chat', profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-pc', workspaceRoot: null, pinned: false, projectPinned: false, unread: false,
    archivedAt: null, autoMode: false, projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
  };
}

let focused = true;

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  mockedPatch.mockImplementation(async (id, body) => ({ ...useOtherBenchStore.getState().chats.find((c) => c.id === id)!, ...body }) as Chat);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mockedPatch.mockReset();
});

function show(...panes: (string | null)[]): void {
  useOtherBenchStore.setState({ paneState: { ...DEFAULT_PANE_STATE, layout: panes.length === 2 ? 'columns-2' : 'single', panes, focusedPane: 0 }, activeChatId: panes[0] ?? null });
}

describe('useMarkRead', () => {
  it('marks an unread chat read once it is on screen in a focused window, here and on the server', () => {
    useOtherBenchStore.setState({ chats: [chat('a', { unread: true }), chat('b', { unread: true })] });
    show('a');
    renderHook(() => useMarkRead(false));

    expect(mockedPatch).toHaveBeenCalledWith('a', { unread: false });
    expect(mockedPatch).toHaveBeenCalledTimes(1);
    expect(useOtherBenchStore.getState().chats.map((c) => c.unread)).toEqual([false, true]);
  });

  it('marks a chat read when a reply finishes while it is on screen', () => {
    useOtherBenchStore.setState({ chats: [chat('a')] });
    show('a');
    renderHook(() => useMarkRead(false));
    expect(mockedPatch).not.toHaveBeenCalled();

    act(() => useOtherBenchStore.getState().upsertChat(chat('a', { unread: true })));
    expect(mockedPatch).toHaveBeenCalledWith('a', { unread: false });
    expect(useOtherBenchStore.getState().chats[0]!.unread).toBe(false);
  });

  it('leaves it unread while the window is in the background, and marks it read when the window comes back', () => {
    focused = false;
    useOtherBenchStore.setState({ chats: [chat('a', { unread: true })] });
    show('a');
    renderHook(() => useMarkRead(false));
    expect(mockedPatch).not.toHaveBeenCalled();

    focused = true;
    act(() => {
      window.dispatchEvent(new FocusEvent('focus'));
    });
    expect(mockedPatch).toHaveBeenCalledWith('a', { unread: false });
  });

  it('only counts the focused pane as on screen in a narrow window', () => {
    useOtherBenchStore.setState({ chats: [chat('a'), chat('b', { unread: true })] });
    show('a', 'b');
    renderHook(() => useMarkRead(true));
    expect(mockedPatch).not.toHaveBeenCalled();
  });
});
