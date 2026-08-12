import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { Profile } from '@grunt/core/types/config.js';
import { useGruntStore } from '../state/store.js';
import { Composer } from './Composer.js';

vi.mock('../state/api.js', () => ({
  api: {
    turns: {
      create: vi.fn(),
      cancel: vi.fn(),
      setHead: vi.fn(),
    },
  },
}));

import { api } from '../state/api.js';

const mockedCreate = vi.mocked(api.turns.create);
const mockedCancel = vi.mocked(api.turns.cancel);
const mockedSetHead = vi.mocked(api.turns.setHead);

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'p1',
    name: 'Default',
    description: null,
    colour: null,
    connectionId: 'c1',
    modelId: 'mock-standard',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: true,
    archivedAt: null,
    ...overrides,
  };
}

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat-1',
    title: 'Test chat',
    profileId: 'p1',
    headMessageId: null,
    workspaceRoot: null,
    pinned: false,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function streamingMessage(id: string, overrides: Partial<CanonMessage> = {}): CanonMessage {
  return {
    id,
    chatId: 'chat-1',
    parentId: 'user-1',
    role: 'assistant',
    parts: [],
    status: 'streaming',
    error: null,
    producedBy: { profileId: 'p1', profileName: 'Default', connectionId: 'c1', modelId: 'mock-standard' },
    createdAt: 0,
    ...overrides,
  };
}

function reset(): void {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  mockedCreate.mockReset();
  mockedCancel.mockReset();
  mockedSetHead.mockReset();
}

describe('Composer', () => {
  beforeEach(() => {
    reset();
    useGruntStore.getState().setProfiles([makeProfile()]);
  });
  afterEach(() => {
    cleanup();
  });

  it('sending posts the right body to the turns API', async () => {
    mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
    mockedSetHead.mockResolvedValue(makeChat());
    const chat = makeChat({ headMessageId: 'existing-head' });
    const user = userEvent.setup();

    render(<Composer chat={chat} />);

    const textbox = screen.getByRole('textbox', { name: /message/i });
    await user.type(textbox, 'Hello there');
    await user.keyboard('{Enter}');

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate).toHaveBeenCalledWith('chat-1', {
      parentId: 'existing-head',
      parts: [{ type: 'text', text: 'Hello there' }],
      profileIds: ['p1'],
    });
  });

  it('Shift+Enter inserts a newline instead of sending', async () => {
    const chat = makeChat();
    const user = userEvent.setup();
    render(<Composer chat={chat} />);

    const textbox = screen.getByRole('textbox', { name: /message/i });
    await user.type(textbox, 'line one');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(textbox, 'line two');

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(textbox).toHaveValue('line one\nline two');
  });

  it('clears the composer after a successful send', async () => {
    mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
    mockedSetHead.mockResolvedValue(makeChat());
    const chat = makeChat();
    const user = userEvent.setup();
    render(<Composer chat={chat} />);

    const textbox = screen.getByRole('textbox', { name: /message/i });
    await user.type(textbox, 'Hello{Enter}');

    expect(textbox).toHaveValue('');
  });

  it('does not send an empty or whitespace-only message', async () => {
    const chat = makeChat();
    const user = userEvent.setup();
    render(<Composer chat={chat} />);

    const textbox = screen.getByRole('textbox', { name: /message/i });
    await user.type(textbox, '   ');
    await user.keyboard('{Enter}');

    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('shows a stop button while a variant is streaming, and it cancels every in-flight variant', async () => {
    const chat = makeChat();
    useGruntStore.getState().registerMessage(streamingMessage('a1'));
    useGruntStore.getState().registerMessage(streamingMessage('a2', { parentId: 'user-1' }));
    // A completed message in the same chat must NOT be cancelled.
    useGruntStore.getState().registerMessage(streamingMessage('a3', { status: 'complete' }));
    mockedCancel.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<Composer chat={chat} />);

    const stopButton = await screen.findByRole('button', { name: /stop/i });
    await user.click(stopButton);

    expect(mockedCancel).toHaveBeenCalledTimes(2);
    expect(mockedCancel).toHaveBeenCalledWith('a1');
    expect(mockedCancel).toHaveBeenCalledWith('a2');
  });

  it('does not show a stop button when nothing in this chat is streaming', () => {
    const chat = makeChat();
    render(<Composer chat={chat} />);

    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });
});
