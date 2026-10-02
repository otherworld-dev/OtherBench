import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';

const desktopListeners = new Map<string, () => void>();
const unlisten = vi.fn();
vi.mock('../desktop/bridge.js', () => ({
  onDesktopEvent: vi.fn(async (name: string, cb: () => void) => {
    desktopListeners.set(name, cb);
    return unlisten;
  }),
}));

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { ...actual.api, chats: { ...actual.api.chats, create: vi.fn() }, search: vi.fn() } };
});

import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { ChatList } from './ChatList.js';

const mockedCreate = vi.mocked(api.chats.create);

const profile: Profile = {
  id: 'profile-1',
  name: 'Everyday',
  description: null,
  colour: null,
  connectionId: 'conn-1',
  modelId: 'm',
  systemPrompt: null,
  params: {},
  toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
  isDefault: true,
  archivedAt: null,
};

const chat: Chat = {
  id: 'chat-new',
  title: 'New Chat',
  profileId: 'profile-1',
  headMessageId: null,
  workspaceRoot: null,
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  useGruntStore.setState({ profiles: [profile] });
  desktopListeners.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatList desktop integration', () => {
  it('starts a new chat with the default profile when the tray asks for one', async () => {
    mockedCreate.mockResolvedValue(chat);
    render(<ChatList />);
    await waitFor(() => expect(desktopListeners.has('tray-new-chat')).toBe(true));

    desktopListeners.get('tray-new-chat')!();

    await waitFor(() => expect(useGruntStore.getState().activeChatId).toBe('chat-new'));
    expect(mockedCreate).toHaveBeenCalledWith({ profileId: 'profile-1' });
  });

  it('unsubscribes on unmount', async () => {
    const { unmount } = render(<ChatList />);
    await waitFor(() => expect(desktopListeners.has('tray-new-chat')).toBe(true));

    unmount();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
