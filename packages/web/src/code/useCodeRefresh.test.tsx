import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import { useOtherBenchStore } from '../state/store.js';
import { useCodeRefresh } from './useCodeRefresh.js';

const chat = (id: string, appId: string | null): Chat => ({
  id, title: `Chat ${id}`, profileId: 'prof', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: null, appId, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
});

const finish = (chatId: string, messageId: string): void =>
  act(() => useOtherBenchStore.getState().applyAppEvent({ type: 'turn-finished', chatId, messageId, status: 'complete' }));

beforeEach(() => {
  window.localStorage.clear();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ chats: [chat('c1', 'a1'), chat('c2', 'a2'), chat('c3', null)] });
});

afterEach(cleanup);

describe('useCodeRefresh (spec 2026-10-20-code-tab-design, "Calls I made": refresh on focus and after a turn)', () => {
  it('calls back when the window is focused', () => {
    const onRefresh = vi.fn();
    renderHook(() => useCodeRefresh('a1', onRefresh));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("calls back when a turn finishes in one of the app's chats, and not in another app's or an ordinary chat", () => {
    const onRefresh = vi.fn();
    renderHook(() => useCodeRefresh('a1', onRefresh));
    finish('c2', 'm1');
    finish('c3', 'm2');
    expect(onRefresh).not.toHaveBeenCalled();
    finish('c1', 'm3');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // Each finish counts, including two in a row in the same chat.
    finish('c1', 'm4');
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('uses the latest callback, and stops listening once unmounted', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ cb }) => useCodeRefresh('a1', cb), { initialProps: { cb: first } });
    rerender({ cb: second });
    finish('c1', 'm1');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    finish('c1', 'm2');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(second).toHaveBeenCalledTimes(1);
  });
});
