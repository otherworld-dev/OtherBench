import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';

const synced: { chatId: string | null; reportStatus: boolean }[] = [];
vi.mock('../state/useChatSync.js', () => ({
  useChatSync: (chatId: string | null, reportStatus: boolean) => {
    synced.push({ chatId, reportStatus });
  },
}));
vi.mock('./Thread.js', () => ({
  Thread: ({ chat }: { chat: Chat | null }) => <div data-testid="thread">{chat?.title ?? 'no chat'}</div>,
}));

import { DEFAULT_PANE_STATE } from '../state/panes.js';
import { useGruntStore } from '../state/store.js';
import { CHAT_DRAG_MIME } from './sidebar/ChatRow.js';
import { PaneGrid } from './PaneGrid.js';

function chat(id: string): Chat {
  return {
    id, title: `Chat ${id}`, profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, autoMode: false,
    projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
  };
}

beforeEach(() => {
  synced.length = 0;
  window.localStorage.clear();
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ chats: [chat('a'), chat('b'), chat('c')], paneState: DEFAULT_PANE_STATE, activeChatId: null });
});

afterEach(cleanup);

const threads = (): string[] => screen.getAllByTestId('thread').map((t) => t.textContent ?? '');

describe('PaneGrid (#824)', () => {
  it('shows one chat in the single layout, and one per pane otherwise, each syncing its own chat', () => {
    useGruntStore.getState().openTab('a');
    useGruntStore.getState().openTab('b');
    const { rerender } = render(<PaneGrid narrow={false} />);
    expect(threads()).toEqual(['Chat b']);

    useGruntStore.getState().setLayout('columns-3');
    rerender(<PaneGrid narrow={false} />);
    expect(threads()).toEqual(['Chat b', 'Chat a', 'no chat']);
    expect(synced.slice(-3)).toEqual([
      { chatId: 'b', reportStatus: true },
      { chatId: 'a', reportStatus: false },
      { chatId: null, reportStatus: false },
    ]);
  });

  it('clicking into a pane focuses it, making its chat the active one', () => {
    useGruntStore.getState().openTab('a');
    useGruntStore.getState().openTab('b');
    useGruntStore.getState().setLayout('columns-2');
    render(<PaneGrid narrow={false} />);
    fireEvent.mouseDown(screen.getByTestId('pane-1'));
    expect(useGruntStore.getState().activeChatId).toBe('a');
    expect(screen.getByTestId('pane-1')).toHaveAttribute('data-focused', 'true');
  });

  it('a chat dropped onto a pane shows there', () => {
    useGruntStore.getState().setLayout('rows-2');
    render(<PaneGrid narrow={false} />);
    fireEvent.drop(screen.getByTestId('pane-1'), {
      dataTransfer: { types: [CHAT_DRAG_MIME], getData: (t: string) => (t === CHAT_DRAG_MIME ? 'c' : ''), dropEffect: 'none' },
    });
    expect(useGruntStore.getState().paneState.panes).toEqual([null, 'c']);
    expect(useGruntStore.getState().activeChatId).toBe('c');
  });

  it('a narrow window shows only the focused pane', () => {
    useGruntStore.getState().openTab('a');
    useGruntStore.getState().openTab('b');
    useGruntStore.getState().setLayout('columns-2');
    useGruntStore.getState().focusPane(1);
    render(<PaneGrid narrow />);
    expect(threads()).toEqual(['Chat a']);
  });

  it('opening a chat from elsewhere fills the focused pane, or focuses the pane already showing it', () => {
    useGruntStore.getState().setLayout('columns-2');
    useGruntStore.getState().setActiveChatId('a');
    useGruntStore.getState().focusPane(1);
    useGruntStore.getState().setActiveChatId('b');
    expect(useGruntStore.getState().paneState.panes).toEqual(['a', 'b']);
    useGruntStore.getState().setActiveChatId('a');
    expect(useGruntStore.getState().paneState.focusedPane).toBe(0);
    // A deleted chat leaves its pane.
    useGruntStore.getState().removeChat('a');
    expect(useGruntStore.getState().paneState.panes).toEqual([null, 'b']);
    expect(useGruntStore.getState().activeChatId).toBeNull();
  });
});
