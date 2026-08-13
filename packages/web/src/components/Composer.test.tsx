import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    attachments: {
      upload: vi.fn(),
      list: vi.fn(),
      contentUrl: (id: string) => `/api/attachments/${id}/content`,
      previewable: (mime: string) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/avif'].includes(mime),
    },
  },
}));

import { api } from '../state/api.js';

const mockedCreate = vi.mocked(api.turns.create);
const mockedCancel = vi.mocked(api.turns.cancel);
const mockedSetHead = vi.mocked(api.turns.setHead);
const mockedUpload = vi.mocked(api.attachments.upload);

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

function makeAttachment(overrides: Partial<Awaited<ReturnType<typeof api.attachments.upload>>> = {}) {
  return {
    id: 'att-1',
    chatId: 'chat-1',
    messageId: null,
    filename: 'photo.png',
    mime: 'image/png',
    size: 1234,
    sha256: 'deadbeef',
    storagePath: '/data/attachments/de/deadbeef',
    extractedText: null,
    ...overrides,
  };
}

function reset(): void {
  useGruntStore.setState(useGruntStore.getInitialState(), true);
  mockedCreate.mockReset();
  mockedCancel.mockReset();
  mockedSetHead.mockReset();
  mockedUpload.mockReset();
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

  // Bug found via the task-31 e2e smoke path: chat.headMessageId lands on the
  // new USER message and stays there (by design -- see the test below), but
  // for a single-profile turn nothing ever advances it past the lone
  // assistant reply, because the only thing that can move it (`keepVariant`)
  // is wired to a "Keep this one" button that Thread only renders when there
  // is more than one variant to choose between. If the NEXT turn is parented
  // on the raw `chat.headMessageId` (the previous turn's USER message, as
  // 'sending posts the right body to the turns API' above demonstrates is
  // the current default), the new user message becomes a SIBLING of the
  // previous assistant reply instead of a child of it -- silently demoting a
  // real reply to a "1 other variant" chip and hiding it from the thread.
  // The caller (Thread.tsx) is expected to compute the already-extended tail
  // (through any single-child run, exactly like `extendForward` does for
  // display) and pass it down explicitly; Composer must use that over its
  // own `chat.headMessageId` whenever it is supplied.
  it('sends the next turn parented on an explicitly-supplied parentId, not the raw chat.headMessageId, when the two differ', async () => {
    mockedCreate.mockResolvedValue({ userMessageId: 'u2', assistantMessageIds: ['a2'] });
    mockedSetHead.mockResolvedValue(makeChat());
    // chat.headMessageId ('user-1') deliberately differs from the extended
    // tail ('assistant-1') a caller would compute -- exactly the post-reply
    // state the bug above describes.
    const chat = makeChat({ headMessageId: 'user-1' });
    const user = userEvent.setup();

    render(<Composer chat={chat} parentId="assistant-1" />);

    const textbox = screen.getByRole('textbox', { name: /message/i });
    await user.type(textbox, 'Follow-up');
    await user.keyboard('{Enter}');

    expect(mockedCreate).toHaveBeenCalledWith('chat-1', {
      parentId: 'assistant-1',
      parts: [{ type: 'text', text: 'Follow-up' }],
      profileIds: ['p1'],
    });
  });

  // Task 27: head always advances to the new USER message, never straight to
  // an assistant reply -- picking a reply is always an explicit "Keep"
  // action, even when there's only one profile (Thread's `extendForward`
  // renders a lone reply automatically, without needing head to point past
  // it -- see Composer's comment at this call site).
  it('advances head to the new user message, not an assistant reply, even for a single-profile turn', async () => {
    mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
    mockedSetHead.mockResolvedValue(makeChat());
    const chat = makeChat();
    const user = userEvent.setup();

    render(<Composer chat={chat} />);
    await user.type(screen.getByRole('textbox', { name: /message/i }), 'Hi{Enter}');

    expect(mockedSetHead).toHaveBeenCalledWith('chat-1', 'u1');
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

  // --- attachments (task 21): drag-and-drop, paste, chip, remove, send -----

  describe('attachments', () => {
    it('dropping a file onto the composer uploads it and renders a chip', async () => {
      mockedUpload.mockResolvedValue(makeAttachment());
      const chat = makeChat();
      render(<Composer chat={chat} />);
      const file = new File(['fake image bytes'], 'photo.png', { type: 'image/png' });

      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [file] } });

      await waitFor(() => expect(mockedUpload).toHaveBeenCalledWith('chat-1', file));
      expect(await screen.findByTestId('attachment-chip')).toHaveTextContent('photo.png');
    });

    it('pasting a file into the message box uploads it and renders a chip', async () => {
      mockedUpload.mockResolvedValue(makeAttachment({ id: 'att-2', filename: 'clip.png' }));
      const chat = makeChat();
      render(<Composer chat={chat} />);
      const file = new File(['fake image bytes'], 'clip.png', { type: 'image/png' });

      fireEvent.paste(screen.getByRole('textbox', { name: /message/i }), { clipboardData: { files: [file] } });

      await waitFor(() => expect(mockedUpload).toHaveBeenCalledWith('chat-1', file));
      expect(await screen.findByTestId('attachment-chip')).toHaveTextContent('clip.png');
    });

    it('removes an attachment chip before sending when its remove button is clicked', async () => {
      mockedUpload.mockResolvedValue(makeAttachment());
      const chat = makeChat();
      const user = userEvent.setup();
      render(<Composer chat={chat} />);
      const file = new File(['x'], 'photo.png', { type: 'image/png' });
      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [file] } });
      await screen.findByTestId('attachment-chip');

      await user.click(screen.getByRole('button', { name: /remove photo.png/i }));

      expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument();
    });

    it('sending includes an uploaded image as an image part alongside the text part', async () => {
      mockedUpload.mockResolvedValue(makeAttachment());
      mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
      mockedSetHead.mockResolvedValue(makeChat());
      const chat = makeChat({ headMessageId: 'existing-head' });
      const user = userEvent.setup();
      render(<Composer chat={chat} />);
      const file = new File(['x'], 'photo.png', { type: 'image/png' });
      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [file] } });
      await screen.findByTestId('attachment-chip');

      await user.type(screen.getByRole('textbox', { name: /message/i }), 'Look at this{Enter}');

      expect(mockedCreate).toHaveBeenCalledWith('chat-1', {
        parentId: 'existing-head',
        parts: [
          { type: 'text', text: 'Look at this' },
          { type: 'image', attachmentId: 'att-1', mime: 'image/png' },
        ],
        profileIds: ['p1'],
      });
      // The composer clears its attachments after a successful send.
      expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument();
    });

    it('a non-image attachment becomes a file part, carrying its filename', async () => {
      mockedUpload.mockResolvedValue(makeAttachment({ id: 'att-3', filename: 'report.pdf', mime: 'application/pdf' }));
      mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
      mockedSetHead.mockResolvedValue(makeChat());
      const chat = makeChat();
      render(<Composer chat={chat} />);
      const file = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' });
      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [file] } });
      await screen.findByTestId('attachment-chip');

      fireEvent.keyDown(screen.getByRole('textbox', { name: /message/i }), { key: 'Enter' });

      await waitFor(() => expect(mockedCreate).toHaveBeenCalled());
      expect(mockedCreate).toHaveBeenCalledWith('chat-1', {
        parentId: null,
        parts: [{ type: 'file', attachmentId: 'att-3', mime: 'application/pdf', filename: 'report.pdf' }],
        profileIds: ['p1'],
      });
    });

    it('lets a message with only an attachment (no text) be sent', async () => {
      mockedUpload.mockResolvedValue(makeAttachment());
      mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
      mockedSetHead.mockResolvedValue(makeChat());
      const chat = makeChat();
      render(<Composer chat={chat} />);
      const file = new File(['x'], 'photo.png', { type: 'image/png' });
      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [file] } });
      await screen.findByTestId('attachment-chip');

      const sendButton = screen.getByRole('button', { name: /send/i });
      expect(sendButton).not.toBeDisabled();
      await userEvent.setup().click(sendButton);

      await waitFor(() => expect(mockedCreate).toHaveBeenCalled());
      expect(mockedCreate.mock.calls[0]?.[1]?.parts).toEqual([{ type: 'image', attachmentId: 'att-1', mime: 'image/png' }]);
    });
  });
});
