import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import { MODE_STORAGE_KEY } from './mode.js';
import { CODE_PANE_STATE_STORAGE_KEY, DEFAULT_PANE_STATE, PANE_STATE_STORAGE_KEY } from './panes.js';

const bridge = vi.hoisted(() => ({ openIn: vi.fn(async () => {}), showWindow: vi.fn(async () => {}) }));
vi.mock('../desktop/bridge.js', async (importOriginal) => ({ ...(await importOriginal<object>()), ...bridge }));

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1', title: 'Hello', profileId: 'p1', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null,
    pinned: false, projectPinned: false, unread: false, autoMode: false, projectId: null, appId: null, memoryCursor: null,
    memoryExcluded: false, sortOrder: 0, archivedAt: null, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

// The store reads its window as it loads, so the page is the Code window's before it is imported.
let store: typeof import('./store.js');
beforeAll(async () => {
  window.localStorage.setItem(MODE_STORAGE_KEY, 'chat');
  window.history.replaceState(null, '', '/?view=code');
  store = await import('./store.js');
});

describe('the undocked Code window', () => {
  const s = () => store.useOtherBenchStore.getState();

  beforeEach(() => {
    bridge.openIn.mockClear();
    bridge.showWindow.mockClear();
    store.useOtherBenchStore.setState({
      chats: [makeChat({ id: 'plain-1' }), makeChat({ id: 'app-chat', appId: 'a' })],
      paneState: DEFAULT_PANE_STATE,
      otherPaneState: DEFAULT_PANE_STATE,
      activeChatId: null,
    });
  });

  it('starts in Code mode whatever the main window last saved', () => {
    expect(store.WINDOW_ROLE).toBe('code');
    expect(s().mode).toBe('code');
  });

  it('opens app chats here and sends the rest to the main window', () => {
    s().setActiveChatId('app-chat');
    expect(s().activeChatId).toBe('app-chat');
    s().setActiveChatId('plain-1');
    s().setMode('chat');
    expect(bridge.openIn).toHaveBeenCalledWith('main', { kind: 'chat', chatId: 'plain-1' });
    expect(bridge.showWindow).toHaveBeenCalledWith('main');
    expect(s().mode).toBe('code');
    expect(s().activeChatId).toBe('app-chat');
  });

  it("saves Code's pane state but never Chat mode's or the mode", () => {
    window.localStorage.clear();
    s().openTab('app-chat');
    s().removeChat('plain-1');
    expect(window.localStorage.getItem(CODE_PANE_STATE_STORAGE_KEY)).not.toBeNull();
    expect(window.localStorage.getItem(PANE_STATE_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBeNull();
  });
});
