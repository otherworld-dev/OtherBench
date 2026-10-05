import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';

vi.mock('../state/api.js', () => ({
  api: {
    profiles: { list: vi.fn() },
    chats: { create: vi.fn() },
    turns: { create: vi.fn() },
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../state/useChatSync.js', () => ({ useChatSync: () => {} }));
vi.mock('../desktop/bridge.js', () => ({
  hideQuick: vi.fn(async () => {}),
  openChatInMain: vi.fn(async () => {}),
  onDesktopEvent: vi.fn(async () => () => {}),
}));

import { hideQuick, openChatInMain } from '../desktop/bridge.js';
import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { QuickChat } from './QuickChat.js';

const profile = (id: string, over: Partial<Profile> = {}): Profile => ({
  id, name: `Profile ${id}`, description: null, colour: null, connectionId: 'c', modelId: 'm', systemPrompt: null, params: {},
  toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null, ...over,
});
const chat = (id: string): Chat => ({
  id, title: 'New Chat', profileId: 'p-default', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, archivedAt: null, autoMode: false,
  projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
});

beforeEach(() => {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  vi.mocked(api.profiles.list).mockResolvedValue([profile('p-other'), profile('p-default', { isDefault: true })]);
  vi.mocked(api.chats.create).mockResolvedValue(chat('q1'));
  vi.mocked(api.turns.create)
    .mockResolvedValueOnce({ userMessageId: 'u1', assistantMessageIds: ['a1'] })
    .mockResolvedValueOnce({ userMessageId: 'u2', assistantMessageIds: ['a2'] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('QuickChat', () => {
  it('sends in a new chat with the default profile, and a follow-up stays in that chat after the reply', async () => {
    const user = userEvent.setup();
    render(<QuickChat />);
    await screen.findByText(/Quick chat · Profile p-default/);
    const box = screen.getByRole('textbox', { name: 'Quick message' });

    await user.type(box, 'what is 2+2{Enter}');
    await waitFor(() => expect(api.turns.create).toHaveBeenCalledWith('q1', { parentId: null, parts: [{ type: 'text', text: 'what is 2+2' }], profileIds: ['p-default'] }));
    expect(api.chats.create).toHaveBeenCalledWith({ profileId: 'p-default' });
    expect(await screen.findByText('what is 2+2')).toBeInTheDocument();

    // The reply finishes (as the stream would report), then a follow-up.
    useGruntStore.setState((s) => ({ messages: { ...s.messages, a1: { ...s.messages['a1']!, status: 'complete', createdAt: s.messages['u1']!.createdAt + 1 } } }));
    await user.type(box, 'and 3+3{Enter}');
    await waitFor(() => expect(api.turns.create).toHaveBeenLastCalledWith('q1', expect.objectContaining({ parentId: 'a1' })));
    expect(api.chats.create).toHaveBeenCalledTimes(1);
  });

  it('Expand hands the chat to the main window and starts afresh; Esc hides the window', async () => {
    const user = userEvent.setup();
    render(<QuickChat />);
    await screen.findByText(/Quick chat · Profile p-default/);
    expect(screen.getByRole('button', { name: 'Expand' })).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Quick message' }), 'hello{Enter}');
    await waitFor(() => expect(api.turns.create).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Expand' }));
    expect(openChatInMain).toHaveBeenCalledWith('q1');
    expect(screen.queryByTestId('quick-thread')).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(hideQuick).toHaveBeenCalled();
  });
});
