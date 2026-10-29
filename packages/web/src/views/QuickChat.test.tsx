import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';

vi.mock('../state/api.js', () => ({
  api: {
    profiles: { list: vi.fn() },
    chats: { create: vi.fn(), patch: vi.fn() },
    turns: { create: vi.fn(), cancel: vi.fn(async () => {}) },
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../state/useChatSync.js', () => ({ useChatSync: () => {} }));
vi.mock('../desktop/useUpdateActivity.js', () => ({ useUpdateActivity: vi.fn() }));
vi.mock('../desktop/bridge.js', () => ({
  hideQuick: vi.fn(async () => {}),
  openChatInMain: vi.fn(async () => {}),
  onDesktopEvent: vi.fn(async () => () => {}),
}));

import { hideQuick, openChatInMain } from '../desktop/bridge.js';
import { useUpdateActivity } from '../desktop/useUpdateActivity.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { hasUnsentText } from '../state/unsent.js';
import { QuickChat } from './QuickChat.js';

const profile = (id: string, over: Partial<Profile> = {}): Profile => ({
  id, name: `Profile ${id}`, description: null, colour: null, connectionId: 'c', modelId: 'm', systemPrompt: null, params: {},
  toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null, ...over,
});
const chat = (id: string): Chat => ({
  id, title: 'New Chat', profileId: 'p-default', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1,
});

beforeEach(() => {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  vi.mocked(api.profiles.list).mockResolvedValue([profile('p-other'), profile('p-default', { isDefault: true })]);
  vi.mocked(api.chats.create).mockResolvedValue(chat('q1'));
  vi.mocked(api.chats.patch).mockResolvedValue(chat('q1'));
  vi.mocked(api.turns.create)
    .mockResolvedValueOnce({ userMessageId: 'u1', assistantMessageIds: ['a1'] })
    .mockResolvedValueOnce({ userMessageId: 'u2', assistantMessageIds: ['a2'] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('QuickChat', () => {
  it('tells the updater when it is used and while it holds unsent text', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<QuickChat />);
    expect(useUpdateActivity).toHaveBeenCalled();
    await screen.findByText(/Quick chat · Profile p-default/);
    await user.type(screen.getByRole('textbox', { name: 'Quick message' }), 'half a thought');
    expect(hasUnsentText()).toBe(true);
    unmount();
    expect(hasUnsentText()).toBe(false);
  });

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
    useOtherBenchStore.setState((s) => ({ messages: { ...s.messages, a1: { ...s.messages['a1']!, status: 'complete', createdAt: s.messages['u1']!.createdAt + 1 } } }));
    await user.type(box, 'and 3+3{Enter}');
    await waitFor(() => expect(api.turns.create).toHaveBeenLastCalledWith('q1', expect.objectContaining({ parentId: 'a1' })));
    expect(api.chats.create).toHaveBeenCalledTimes(1);
  });

  it('marks the chat read when a reply finishes with the window in front, or once it comes back to the front', async () => {
    let focused = true;
    const hasFocus = vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    const user = userEvent.setup();
    render(<QuickChat />);
    await screen.findByText(/Quick chat · Profile p-default/);
    const box = screen.getByRole('textbox', { name: 'Quick message' });
    await user.type(box, 'hello{Enter}');
    await waitFor(() => expect(api.turns.create).toHaveBeenCalled());
    expect(api.chats.patch).not.toHaveBeenCalled();

    act(() => useOtherBenchStore.setState((s) => ({ messages: { ...s.messages, a1: { ...s.messages['a1']!, status: 'complete' } } })));
    expect(api.chats.patch).toHaveBeenCalledWith('q1', { unread: false });

    // A second reply finishes while the window is behind another: read when it comes back.
    await user.type(box, 'again{Enter}');
    await waitFor(() => expect(api.turns.create).toHaveBeenCalledTimes(2));
    act(() => {
      focused = false;
      window.dispatchEvent(new FocusEvent('blur'));
    });
    act(() => useOtherBenchStore.setState((s) => ({ messages: { ...s.messages, a2: { ...s.messages['a2']!, status: 'complete' } } })));
    expect(api.chats.patch).toHaveBeenCalledTimes(1);
    act(() => {
      focused = true;
      window.dispatchEvent(new FocusEvent('focus'));
    });
    expect(api.chats.patch).toHaveBeenCalledTimes(2);
    // Focus coming and going again with nothing new sends nothing.
    act(() => {
      window.dispatchEvent(new FocusEvent('blur'));
      window.dispatchEvent(new FocusEvent('focus'));
    });
    expect(api.chats.patch).toHaveBeenCalledTimes(2);
    hasFocus.mockRestore();
  });

  it('Esc stops a running reply instead of hiding the window', async () => {
    const user = userEvent.setup();
    render(<QuickChat />);
    await screen.findByText(/Quick chat · Profile p-default/);
    await user.type(screen.getByRole('textbox', { name: 'Quick message' }), 'hello{Enter}');
    await waitFor(() => expect(api.turns.create).toHaveBeenCalled());
    act(() => {
      useOtherBenchStore.getState().registerMessage({ id: 'a-run', chatId: 'q1', parentId: null, role: 'assistant', parts: [], status: 'streaming', error: null, producedBy: null, createdAt: 2 } as never);
    });
    await user.keyboard('{Escape}');
    expect(api.turns.cancel).toHaveBeenCalledWith('a-run');
    expect(hideQuick).not.toHaveBeenCalled();
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
