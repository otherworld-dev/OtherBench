import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import type { Connection, Profile } from '@otherbench/core/types/config.js';
import type { ReplyNote } from '@otherbench/core/types/notes.js';
import { CLIENT_ID } from '../lib/clientId.js';
import { OWN_COMMANDS, type CommandRow } from '@otherbench/core/domain/context-lines.js';
import { useOtherBenchStore } from '../state/store.js';
import { Composer } from './Composer.js';

vi.mock('../state/api.js', () => ({
  api: {
    turns: {
      create: vi.fn(),
      cancel: vi.fn(),
      setHead: vi.fn(),
    },
    chats: { patch: vi.fn(), commands: vi.fn(async () => ({ commands: [...OWN_COMMANDS] })) },
    notes: { send: vi.fn(), withdraw: vi.fn() },
    claude: { planUsage: vi.fn(async () => ({ usage: null })) },
    attachments: {
      upload: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
      contentUrl: (id: string) => `/api/attachments/${id}/content`,
      previewable: (mime: string) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/avif'].includes(mime),
    },
  },
  ApiError: class ApiError extends Error {
    status: number;
    kind?: string;
    constructor(status: number, message: string, kind?: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      if (kind !== undefined) this.kind = kind;
    }
  },
}));

import { api, ApiError } from '../state/api.js';

const mockedCreate = vi.mocked(api.turns.create);
const mockedCancel = vi.mocked(api.turns.cancel);
const mockedSetHead = vi.mocked(api.turns.setHead);
const mockedUpload = vi.mocked(api.attachments.upload);
const mockedAttachmentList = vi.mocked(api.attachments.list);
const mockedDelete = vi.mocked(api.attachments.delete);
const mockedChatsPatch = vi.mocked(api.chats.patch);
const mockedNoteSend = vi.mocked(api.notes.send);

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
    workspace: null,
    runsOn: 'node-self',
    workspaceRoot: null,
    pinned: false,
    projectPinned: false,
    unread: false,
    autoMode: false,
    projectId: null, appId: null,
    memoryCursor: null,
    memoryExcluded: false,
    sortOrder: 0,
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
    extractedText: null,
    ...overrides,
  };
}

function reset(): void {
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  mockedCreate.mockReset();
  mockedCancel.mockReset();
  mockedSetHead.mockReset();
  mockedUpload.mockReset();
  mockedDelete.mockReset();
  mockedChatsPatch.mockReset();
  mockedNoteSend.mockReset();
}

describe('Composer', () => {
  beforeEach(() => {
    reset();
    useOtherBenchStore.getState().setProfiles([makeProfile()]);
  });
  afterEach(() => {
    cleanup();
  });

  it('keeps the message field, attach, the profile and Send in one box', () => {
    render(<Composer chat={makeChat()} />);
    const box = screen.getByRole('textbox', { name: /message/i }).closest('[data-composer-box]') as HTMLElement;
    expect(box).not.toBeNull();
    for (const name of ['Attach files', 'Send', 'Default · mock-standard', 'Compare']) {
      expect(within(box).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  // Whether Send really stays in the box at every width is measured in a browser: e2e/composer-toolbar.spec.ts.
  it('keeps its controls on one line until the box is very narrow, lets Send drop to a line of its own rather than out of the box, the profile name truncates (full name in its tooltip), Compare is a +', () => {
    render(<Composer chat={makeChat()} />);
    const attach = screen.getByRole('button', { name: 'Attach files' });
    const controls = attach.parentElement!;
    // No min-w-0: the controls' own width is what makes Send drop to its own line, rather than slide under them.
    expect(controls).toHaveClass('flex-1', '@max-xs:flex-wrap');
    expect(controls).not.toHaveClass('min-w-0');
    expect(controls).not.toHaveClass('flex-wrap');
    expect(controls.parentElement).toHaveClass('flex-wrap');
    expect(attach.closest('[data-composer-box]')).toHaveClass('@container');
    const profile = screen.getByRole('button', { name: 'Default · mock-standard' });
    expect(profile).toHaveClass('line-clamp-1', 'break-all');
    // It gives way first, but never down to nothing.
    expect(profile.parentElement).toHaveClass('shrink', 'min-w-14');
    expect(profile).toHaveAttribute('title', 'Default · mock-standard');
    const compare = screen.getByRole('button', { name: 'Compare' });
    expect(compare).toHaveTextContent(/^\+$/);
    expect(compare).toHaveAttribute('title', 'Compare against other profiles');
  });

  it('starts one line high with a short placeholder, the keys in its tooltip, and grows with the text', async () => {
    render(<Composer chat={makeChat()} />);
    const textbox = screen.getByRole('textbox', { name: /message/i });
    expect(textbox).toHaveAttribute('rows', '1');
    expect(textbox).toHaveAttribute('placeholder', 'Message…');
    expect(textbox.getAttribute('title')).toMatch(/Enter to send, Shift\+Enter for a new line/);
    Object.defineProperty(textbox, 'scrollHeight', { configurable: true, get: () => 120 });
    await userEvent.setup().type(textbox, 'a');
    expect(textbox.style.height).toBe('120px');
  });

  it('sends /compact to the one profile the server ran, with one reply stub', async () => {
    const p2 = makeProfile({ id: 'p2', name: 'Other' });
    useOtherBenchStore.getState().setProfiles([makeProfile(), p2]);
    mockedCreate.mockResolvedValue({
      userMessageId: 'u1',
      assistantMessageIds: ['a1'],
      profileIds: ['p2'],
      userParts: [{ type: 'context', kind: 'compact' }],
    });
    mockedSetHead.mockResolvedValue(makeChat());
    const user = userEvent.setup();
    render(<Composer chat={makeChat()} />);
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    await user.click(screen.getByRole('checkbox', { name: 'Other' }));
    await user.type(screen.getByRole('textbox', { name: /message/i }), '/compact');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mockedCreate).toHaveBeenCalled());
    expect(mockedCreate.mock.calls[0]![1].profileIds).toEqual(['p1', 'p2']);
    const { messages } = useOtherBenchStore.getState();
    expect(messages['u1']!.parts).toEqual([{ type: 'context', kind: 'compact' }]);
    expect(messages['a1']!.producedBy?.profileId).toBe('p2');
    expect(Object.keys(messages).sort()).toEqual(['a1', 'u1']);
  });

  it('shows /clear as its line at once, with no reply stub', async () => {
    mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: [], profileIds: [], userParts: [{ type: 'context', kind: 'clear' }] });
    mockedSetHead.mockResolvedValue(makeChat());
    const user = userEvent.setup();
    render(<Composer chat={makeChat()} />);
    await user.type(screen.getByRole('textbox', { name: /message/i }), '/clear');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mockedCreate).toHaveBeenCalled());
    await waitFor(() => expect(useOtherBenchStore.getState().messages['u1']).toBeDefined());
    expect(useOtherBenchStore.getState().messages['u1']!.parts).toEqual([{ type: 'context', kind: 'clear' }]);
    expect(Object.keys(useOtherBenchStore.getState().messages)).toEqual(['u1']);
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

  it('keeps the message and says why when the send fails, and clears that on the next one', async () => {
    mockedCreate.mockRejectedValueOnce(new ApiError(500, 'FOREIGN KEY constraint failed'));
    const chat = makeChat();
    const user = userEvent.setup();
    render(<Composer chat={chat} />);

    const textbox = screen.getByRole('textbox', { name: /message/i });
    await user.type(textbox, 'Hello{Enter}');

    expect(textbox).toHaveValue('Hello');
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't send: FOREIGN KEY constraint failed");

    mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
    mockedSetHead.mockResolvedValue(makeChat());
    await user.keyboard('{Enter}');
    expect(textbox).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
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


  it("sends nothing while the chat's folder doesn't resolve on this machine (the prompt above asks first)", async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ workspaceStatus: { status: 'unresolved', reason: 'other-machine' } })} />);
    const box = screen.getByRole('textbox', { name: /message/i });
    await user.type(box, 'hello');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(box).toHaveValue('hello');
  });

  it('shows a stop button while a variant is streaming, and it cancels every in-flight variant', async () => {
    const chat = makeChat();
    useOtherBenchStore.getState().registerMessage(streamingMessage('a1'));
    useOtherBenchStore.getState().registerMessage(streamingMessage('a2', { parentId: 'user-1' }));
    // A completed message in the same chat must NOT be cancelled.
    useOtherBenchStore.getState().registerMessage(streamingMessage('a3', { status: 'complete' }));
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

    it('the Attach button opens the file picker and uploads what is chosen', async () => {
      mockedUpload.mockResolvedValue(makeAttachment({ id: 'att-3', filename: 'picked.png' }));
      const user = userEvent.setup();
      render(<Composer chat={makeChat()} />);
      const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
      const click = vi.spyOn(input, 'click');
      await user.click(screen.getByRole('button', { name: 'Attach files' }));
      expect(click).toHaveBeenCalled();

      const file = new File(['bytes'], 'picked.png', { type: 'image/png' });
      await user.upload(input, file);
      await waitFor(() => expect(mockedUpload).toHaveBeenCalledWith('chat-1', file));
      expect(await screen.findByTestId('attachment-chip')).toHaveTextContent('picked.png');
    });

    it('shows attachments already on the server but not yet sent as chips when it opens, and not sent ones', async () => {
      mockedAttachmentList.mockResolvedValueOnce([
        makeAttachment({ id: 'waiting', filename: 'waiting.png', messageId: null }),
        makeAttachment({ id: 'sent', filename: 'sent.png', messageId: 'm-1' }),
      ]);
      render(<Composer chat={makeChat()} />);
      expect(await screen.findByTestId('attachment-chip')).toHaveTextContent('waiting.png');
      expect(screen.getAllByTestId('attachment-chip')).toHaveLength(1);
      expect(mockedAttachmentList).toHaveBeenCalledWith('chat-1');
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

    describe('upload size pre-check (25MB cap)', () => {
      const CAP = 25 * 1024 * 1024;
      /** A File that reports a given size without allocating it. */
      function fileOfSize(name: string, size: number): File {
        const f = new File(['x'], name, { type: 'application/octet-stream' });
        Object.defineProperty(f, 'size', { value: size });
        return f;
      }
      const TOO_LARGE = 'That upload is too large. Attachments are limited to 25MB per file.';

      it('refuses an oversized dropped file without starting an upload, and says why', async () => {
        render(<Composer chat={makeChat()} />);

        fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [fileOfSize('huge.bin', CAP + 1)] } });

        expect(await screen.findByRole('alert')).toHaveTextContent(TOO_LARGE);
        expect(mockedUpload).not.toHaveBeenCalled();
        expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument();
      });

      it('refuses an oversized pasted file the same way', async () => {
        render(<Composer chat={makeChat()} />);

        fireEvent.paste(screen.getByRole('textbox', { name: /message/i }), { clipboardData: { files: [fileOfSize('huge.bin', 300 * 1024 * 1024)] } });

        expect(await screen.findByRole('alert')).toHaveTextContent(TOO_LARGE);
        expect(mockedUpload).not.toHaveBeenCalled();
      });

      it('uploads a file of exactly the cap, and still uploads the OK files in a batch that includes an oversized one', async () => {
        mockedUpload.mockResolvedValue(makeAttachment({ filename: 'ok.bin' }));
        render(<Composer chat={makeChat()} />);
        const ok = fileOfSize('ok.bin', CAP);
        const big = fileOfSize('big.bin', CAP + 1);

        fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [big, ok] } });

        await waitFor(() => expect(mockedUpload).toHaveBeenCalledTimes(1));
        expect(mockedUpload).toHaveBeenCalledWith('chat-1', ok);
        expect(screen.getByRole('alert')).toHaveTextContent(TOO_LARGE);
        expect(await screen.findByTestId('attachment-chip')).toHaveTextContent('ok.bin');
      });

      it('clears the message when the next upload batch starts', async () => {
        mockedUpload.mockResolvedValue(makeAttachment());
        render(<Composer chat={makeChat()} />);
        fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [fileOfSize('big.bin', CAP + 1)] } });
        await screen.findByRole('alert');

        fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [new File(['hi'], 'a.txt', { type: 'text/plain' })] } });

        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      });
    });

    it('removes an attachment chip before sending when its remove button is clicked, by calling DELETE on the server', async () => {
      mockedUpload.mockResolvedValue(makeAttachment());
      mockedDelete.mockResolvedValue(undefined);
      const chat = makeChat();
      const user = userEvent.setup();
      render(<Composer chat={chat} />);
      const file = new File(['x'], 'photo.png', { type: 'image/png' });
      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [file] } });
      await screen.findByTestId('attachment-chip');

      await user.click(screen.getByRole('button', { name: /remove photo.png/i }));

      await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('att-1'));
      expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument();
    });

    // Task 32 decision #4: a DELETE failure must not silently drop the chip
    // -- the server-side row (and the part it would become on send) would
    // still exist with nothing in the composer showing it. The chip stays,
    // and the failure surfaces as a visible error instead.
    it('keeps the chip and shows an error when removing an attachment fails', async () => {
      mockedUpload.mockResolvedValue(makeAttachment());
      mockedDelete.mockRejectedValue(new ApiError(409, 'Attachment "att-1" has already been sent as part of a message and cannot be deleted.'));
      const chat = makeChat();
      const user = userEvent.setup();
      render(<Composer chat={chat} />);
      const file = new File(['x'], 'photo.png', { type: 'image/png' });
      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [file] } });
      await screen.findByTestId('attachment-chip');

      await user.click(screen.getByRole('button', { name: /remove photo.png/i }));

      await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith('att-1'));
      expect(screen.getByTestId('attachment-chip')).toBeInTheDocument();
      expect(await screen.findByRole('alert')).toHaveTextContent(/already been sent/i);
    });

    // Task 32 fix round 1, Minor #9: a 404 means the row is ALREADY gone
    // (e.g. a second click raced the first's own state update, or another
    // tab deleted it first) -- that's success from the user's point of
    // view, not a failure to report.
    it('treats a 404 on delete as success: the chip disappears, no error is shown', async () => {
      mockedUpload.mockResolvedValue(makeAttachment());
      mockedDelete.mockRejectedValue(new ApiError(404, 'Attachment "att-1" not found.'));
      const chat = makeChat();
      const user = userEvent.setup();
      render(<Composer chat={chat} />);
      const file = new File(['x'], 'photo.png', { type: 'image/png' });
      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [file] } });
      await screen.findByTestId('attachment-chip');

      await user.click(screen.getByRole('button', { name: /remove photo.png/i }));

      await waitFor(() => expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    // Minor #9: the remove button must be disabled while a send is in
    // flight, so a click can't race the attachment actually being sent.
    it('disables the remove button while a send is in flight', async () => {
      mockedUpload.mockResolvedValue(makeAttachment());
      let resolveCreate!: (value: { userMessageId: string; assistantMessageIds: string[] }) => void;
      mockedCreate.mockReturnValue(new Promise<{ userMessageId: string; assistantMessageIds: string[] }>((resolve) => { resolveCreate = resolve; }));
      const chat = makeChat();
      const user = userEvent.setup();
      render(<Composer chat={chat} />);
      const file = new File(['x'], 'photo.png', { type: 'image/png' });
      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [file] } });
      await screen.findByTestId('attachment-chip');

      await user.type(screen.getByRole('textbox', { name: /message/i }), 'Sending now{Enter}');

      expect(screen.getByRole('button', { name: /remove photo.png/i })).toBeDisabled();

      resolveCreate({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
      mockedSetHead.mockResolvedValue(makeChat());
      await waitFor(() => expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument());
    });

    // Minor #9: a stale remove-failure banner must not linger once the
    // user has moved on to a new upload or a new send attempt.
    it('clears a previous remove-failure message when a new file is uploaded', async () => {
      mockedUpload.mockResolvedValueOnce(makeAttachment());
      mockedDelete.mockRejectedValue(new ApiError(409, 'Attachment "att-1" has already been sent as part of a message and cannot be deleted.'));
      const chat = makeChat();
      const user = userEvent.setup();
      render(<Composer chat={chat} />);
      const firstFile = new File(['x'], 'photo.png', { type: 'image/png' });
      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [firstFile] } });
      await screen.findByTestId('attachment-chip');
      await user.click(screen.getByRole('button', { name: /remove photo.png/i }));
      await screen.findByRole('alert');

      mockedUpload.mockResolvedValueOnce(makeAttachment({ id: 'att-2', filename: 'second.png' }));
      const secondFile = new File(['y'], 'second.png', { type: 'image/png' });
      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [secondFile] } });

      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    });

    it('clears a previous remove-failure message when a new send is attempted', async () => {
      mockedUpload.mockResolvedValue(makeAttachment());
      mockedDelete.mockRejectedValue(new ApiError(409, 'Attachment "att-1" has already been sent as part of a message and cannot be deleted.'));
      mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
      mockedSetHead.mockResolvedValue(makeChat());
      const chat = makeChat();
      const user = userEvent.setup();
      render(<Composer chat={chat} />);
      const file = new File(['x'], 'photo.png', { type: 'image/png' });
      fireEvent.drop(screen.getByTestId('composer-dropzone'), { dataTransfer: { files: [file] } });
      await screen.findByTestId('attachment-chip');
      await user.click(screen.getByRole('button', { name: /remove photo.png/i }));
      await screen.findByRole('alert');

      await user.type(screen.getByRole('textbox', { name: /message/i }), 'moving on{Enter}');

      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
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

  it('tags each profile with its toolset, and lets a Claude Code chat with no folder send (a clean chat)', async () => {
    const conn = (id: string, kind: Connection['kind']): Connection => ({
      id,
      name: id,
      kind,
      baseUrl: null,
      secretRef: null,
      extraHeaders: {},
      status: 'ok',
      statusMessage: null,
      checkedAt: null,
    });
    useOtherBenchStore.getState().setConnections([conn('cc', 'claude_code'), conn('oll', 'ollama')]);
    useOtherBenchStore.getState().setProfiles([
      makeProfile({ id: 'sonnet', name: 'Sonnet', connectionId: 'cc', modelId: 'sonnet' }),
      makeProfile({ id: 'qwen', name: 'Qwen', connectionId: 'oll', modelId: 'qwen3', isDefault: false }),
    ]);
    const user = userEvent.setup();

    render(<Composer chat={makeChat({ profileId: 'sonnet', workspaceRoot: null })} />);
    await user.click(screen.getByRole('button', { name: /Sonnet/ }));
    expect(screen.getByRole('option', { name: /Sonnet.*CC tools/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Qwen.*OtherBench tools/ })).toBeInTheDocument();

    mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
    mockedSetHead.mockResolvedValue(makeChat({ profileId: 'sonnet', workspaceRoot: null }));
    await user.type(screen.getByRole('textbox', { name: /message/i }), 'hello');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(screen.queryByText(/Set a workspace folder/)).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });
});

describe('Composer profile picker', () => {
  beforeEach(() => {
    reset();
    useOtherBenchStore.getState().setProfiles([
      makeProfile({ id: 'p1', name: 'Default', modelId: 'mock-standard' }),
      makeProfile({ id: 'p2', name: 'Opus', modelId: 'opus', isDefault: false }),
    ]);
  });
  afterEach(cleanup);

  it("keeps the chosen profile on the chat, so it's still chosen after switching away and back", async () => {
    const chat = makeChat({ profileId: 'p1' });
    useOtherBenchStore.getState().setChats([chat]);
    mockedChatsPatch.mockImplementation(async (_id, body) => ({ ...chat, ...(body as Partial<Chat>) }));
    const user = userEvent.setup();
    const { unmount } = render(<Composer chat={chat} />);

    await user.click(screen.getByRole('button', { name: 'Default · mock-standard' }));
    await user.click(screen.getByRole('option', { name: /Opus/ }));

    expect(mockedChatsPatch).toHaveBeenCalledWith('chat-1', { profileId: 'p2' });
    await waitFor(() => expect(useOtherBenchStore.getState().chats[0]!.profileId).toBe('p2'));
    // Switching chats remounts the composer with the chat as the store now has it.
    unmount();
    render(<Composer chat={useOtherBenchStore.getState().chats[0]!} />);
    expect(screen.getByRole('button', { name: 'Opus · opus' })).toBeInTheDocument();
  });

  it("doesn't save when the profile already chosen is picked again, and puts the chat's profile back when saving fails", async () => {
    const chat = makeChat({ profileId: 'p1' });
    useOtherBenchStore.getState().setChats([chat]);
    const user = userEvent.setup();
    render(<Composer chat={chat} />);

    await user.click(screen.getByRole('button', { name: 'Default · mock-standard' }));
    await user.click(screen.getByRole('option', { name: /Default/ }));
    expect(mockedChatsPatch).not.toHaveBeenCalled();

    mockedChatsPatch.mockRejectedValue(new ApiError(500, 'Database is locked.'));
    await user.click(screen.getByRole('button', { name: 'Default · mock-standard' }));
    await user.click(screen.getByRole('option', { name: /Opus/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is locked.');
    expect(useOtherBenchStore.getState().chats[0]!.profileId).toBe('p1');
  });
});

describe('Composer auto mode toggle', () => {
  const HINT = 'Auto mode: Claude Code decides routine tool calls; your profile limits still apply.';
  const conn = (id: string, kind: Connection['kind'], baseUrl: string | null = null): Connection => ({
    id, name: id, kind, baseUrl, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null,
  });

  beforeEach(() => {
    reset();
    useOtherBenchStore.getState().setConnections([conn('cc', 'claude_code'), conn('cc-endpoint', 'claude_code', 'http://localhost:11434'), conn('oll', 'ollama')]);
    useOtherBenchStore.getState().setProfiles([
      makeProfile({ id: 'sonnet', name: 'Sonnet', connectionId: 'cc', modelId: 'sonnet' }),
      makeProfile({ id: 'local-cc', name: 'Local CC', connectionId: 'cc-endpoint', modelId: 'qwen3', isDefault: false }),
      makeProfile({ id: 'qwen', name: 'Qwen', connectionId: 'oll', modelId: 'qwen3', isDefault: false }),
    ]);
  });
  afterEach(cleanup);

  function renderWith(overrides: Partial<Chat>): Chat {
    const chat = makeChat({ workspaceRoot: '/ws', ...overrides });
    useOtherBenchStore.getState().setChats([chat]);
    render(<Composer chat={chat} />);
    return chat;
  }
  const toggle = () => screen.getByRole('button', { name: 'Auto mode' });

  it('is hidden when no selected profile uses Claude Code', () => {
    renderWith({ profileId: 'qwen' });
    expect(screen.queryByRole('button', { name: 'Auto mode' })).not.toBeInTheDocument();
  });

  it('shows for a Claude Code profile, off by default, with no hint', () => {
    renderWith({ profileId: 'sonnet' });
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(toggle()).toBeEnabled();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('shows in a compare turn when any selected profile uses Claude Code', async () => {
    const user = userEvent.setup();
    renderWith({ profileId: 'qwen' });
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    await user.click(screen.getByRole('checkbox', { name: 'Sonnet' }));
    expect(toggle()).toBeEnabled();
  });

  it('turns on optimistically, patches the chat, and says what Auto does in its tooltip rather than a line of its own', async () => {
    let resolvePatch!: (c: Chat) => void;
    mockedChatsPatch.mockReturnValue(new Promise<Chat>((r) => { resolvePatch = r; }));
    const chat = renderWith({ profileId: 'sonnet' });
    await userEvent.setup().click(toggle());
    expect(mockedChatsPatch).toHaveBeenCalledWith('chat-1', { autoMode: true });
    expect(useOtherBenchStore.getState().chats[0]!.autoMode).toBe(true);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(toggle()).toHaveAttribute('title', 'Auto mode is on: Claude Code decides routine tool calls; your profile limits still apply.');
    resolvePatch({ ...chat, autoMode: true });
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
  });

  it('sends one PATCH for a double click while the save is in flight', async () => {
    mockedChatsPatch.mockReturnValue(new Promise<Chat>(() => {}));
    renderWith({ profileId: 'sonnet' });
    const user = userEvent.setup();
    await user.click(toggle());
    await user.click(toggle());
    expect(mockedChatsPatch).toHaveBeenCalledTimes(1);
    expect(toggle()).toBeDisabled();
  });

  it('reverts only autoMode and shows the error when saving fails', async () => {
    mockedChatsPatch.mockImplementation(async () => {
      // Another change lands while the save is in flight; the revert must keep it.
      useOtherBenchStore.getState().upsertChat({ ...useOtherBenchStore.getState().chats[0]!, title: 'Renamed meanwhile' });
      throw new ApiError(500, 'Database is locked.');
    });
    renderWith({ profileId: 'sonnet' });
    await userEvent.setup().click(toggle());
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is locked.');
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(useOtherBenchStore.getState().chats[0]).toMatchObject({ autoMode: false, title: 'Renamed meanwhile' });
  });

  it('is disabled, with the reason, when every selected Claude Code profile uses an endpoint', () => {
    renderWith({ profileId: 'local-cc' });
    expect(toggle()).toBeDisabled();
    expect(toggle()).toHaveAttribute('title', 'Auto mode needs the Claude login');
  });

  it('shows no hint while unavailable, even if the chat has auto mode on', () => {
    renderWith({ profileId: 'local-cc', autoMode: true });
    expect(toggle()).toBeDisabled();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it('does not announce pressed while unavailable, even if the chat has auto mode on', () => {
    renderWith({ profileId: 'local-cc', autoMode: true });
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not re-insert a chat removed from the store during a failed save', async () => {
    mockedChatsPatch.mockImplementation(async () => {
      useOtherBenchStore.getState().setChats([]);
      throw new ApiError(500, 'Gone.');
    });
    renderWith({ profileId: 'sonnet' });
    await userEvent.setup().click(toggle());
    expect(await screen.findByRole('alert')).toHaveTextContent('Gone.');
    expect(useOtherBenchStore.getState().chats).toEqual([]);
  });

  describe('effort', () => {
    const effort = () => screen.getByRole('combobox', { name: 'Effort' });

    it("shows beside Auto for a Claude Code profile, on Claude Code's own setting by default, and not otherwise", () => {
      renderWith({ profileId: 'sonnet' });
      expect(effort()).toHaveValue('');
      // Just the level, to keep the toolbar short; the tooltip says what it is.
      expect(effort()).toHaveDisplayValue('default');
      expect(effort().getAttribute('title')).toMatch(/^Effort:/);
      // Sized to the level it shows, not its longest option, so it takes no more room than it needs.
      expect(effort()).toHaveClass('field-sizing-content');
      cleanup();
      renderWith({ profileId: 'qwen' });
      expect(screen.queryByRole('combobox', { name: 'Effort' })).not.toBeInTheDocument();
    });

    it("changes the chat's effort from the next message, and back to the default", async () => {
      mockedChatsPatch.mockImplementation(async (_id, body) => ({ ...useOtherBenchStore.getState().chats[0]!, ...body }) as Chat);
      renderWith({ profileId: 'sonnet' });
      const user = userEvent.setup();

      await user.selectOptions(effort(), 'high');
      expect(mockedChatsPatch).toHaveBeenCalledWith('chat-1', { effort: 'high' });
      await waitFor(() => expect(useOtherBenchStore.getState().chats[0]!.effort).toBe('high'));
      expect(effort()).toHaveValue('high');

      await user.selectOptions(effort(), 'default');
      expect(mockedChatsPatch).toHaveBeenLastCalledWith('chat-1', { effort: null });
      await waitFor(() => expect(effort()).toHaveValue(''));
    });

    it('goes back to what it was and says why when saving fails', async () => {
      mockedChatsPatch.mockRejectedValue(new ApiError(500, 'Database is locked.'));
      renderWith({ profileId: 'sonnet', effort: 'medium' });
      await userEvent.setup().selectOptions(effort(), 'max');
      expect(await screen.findByRole('alert')).toHaveTextContent('Database is locked.');
      expect(effort()).toHaveValue('medium');
      expect(useOtherBenchStore.getState().chats[0]!.effort).toBe('medium');
    });
  });

  it('shows the Claude plan usage beside Effort for a profile on the Claude login, and not on an endpoint or another engine', async () => {
    vi.mocked(api.claude.planUsage).mockResolvedValue({ usage: { fetchedAt: 0, windows: [{ id: 'five_hour', label: '5-hour', percent: 7, resetsAt: null }, { id: 'seven_day', label: 'Weekly', percent: 80, resetsAt: null }] } });
    renderWith({ profileId: 'sonnet' });
    expect(await screen.findByTestId('plan-usage')).toHaveTextContent('5h 7% · week 80%');
    for (const profileId of ['local-cc', 'qwen']) {
      cleanup();
      renderWith({ profileId });
      await waitFor(() => expect(screen.queryByTestId('plan-usage')).not.toBeInTheDocument());
    }
    vi.mocked(api.claude.planUsage).mockResolvedValue({ usage: null });
  });
});

describe('Composer plan mode pill', () => {
  beforeEach(() => {
    reset();
    useOtherBenchStore.getState().setProfiles([makeProfile()]);
  });
  afterEach(cleanup);
  const pill = () => screen.getByRole('button', { name: 'Plan mode' });

  it('shows for every profile, off by default, saying what it does', () => {
    const chat = makeChat();
    useOtherBenchStore.getState().setChats([chat]);
    render(<Composer chat={chat} />);
    expect(pill()).toHaveAttribute('aria-pressed', 'false');
    expect(pill()).toHaveAttribute('title', 'Plan first: the model sets out a plan and waits for your approval before it changes anything (from the next message)');
  });

  it('turns on optimistically and saves', async () => {
    let resolvePatch!: (c: Chat) => void;
    mockedChatsPatch.mockReturnValue(new Promise<Chat>((r) => { resolvePatch = r; }));
    const chat = makeChat();
    useOtherBenchStore.getState().setChats([chat]);
    render(<Composer chat={chat} />);
    await userEvent.setup().click(pill());
    expect(mockedChatsPatch).toHaveBeenCalledWith('chat-1', { planMode: true });
    expect(pill()).toHaveAttribute('aria-pressed', 'true');
    resolvePatch({ ...chat, planMode: true });
    await waitFor(() => expect(pill()).toBeEnabled());
  });

  it('reverts only planMode and shows the error when saving fails', async () => {
    mockedChatsPatch.mockRejectedValue(new ApiError(500, 'Database is locked.'));
    const chat = makeChat();
    useOtherBenchStore.getState().setChats([chat]);
    render(<Composer chat={chat} />);
    await userEvent.setup().click(pill());
    expect(await screen.findByRole('alert')).toHaveTextContent('Database is locked.');
    expect(pill()).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('Composer message history (Up and Down)', () => {
  function said(id: string, parentId: string | null, role: 'user' | 'assistant', text: string): CanonMessage {
    return { id, chatId: 'chat-1', parentId, role, parts: [{ type: 'text', text }], status: 'complete', error: null, producedBy: null, createdAt: 1 };
  }
  const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: /message/i });

  beforeEach(() => {
    reset();
    useOtherBenchStore.getState().setProfiles([makeProfile()]);
    for (const m of [said('u1', null, 'user', 'first'), said('a1', 'u1', 'assistant', 'ok'), said('u2', 'a1', 'user', 'second'), said('a2', 'u2', 'assistant', 'ok')]) {
      useOtherBenchStore.getState().registerMessage(m);
    }
  });
  afterEach(() => {
    cleanup();
  });

  it("Up steps back through this chat's messages, Down steps forward and then puts the draft back", async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ headMessageId: 'a2' })} />);
    await user.type(box(), 'draft');

    await user.keyboard('{ArrowUp}');
    expect(box()).toHaveValue('second');
    await user.keyboard('{ArrowUp}');
    expect(box()).toHaveValue('first');
    await user.keyboard('{ArrowUp}');
    expect(box()).toHaveValue('first'); // the oldest: Up has nothing further back

    await user.keyboard('{ArrowDown}');
    expect(box()).toHaveValue('second');
    await user.keyboard('{ArrowDown}');
    expect(box()).toHaveValue('draft');
  });

  it('only recalls from the first line, so Up still moves around a message of several lines', async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ headMessageId: 'a2' })} />);
    await user.type(box(), 'one{Shift>}{Enter}{/Shift}two');
    await user.keyboard('{ArrowUp}');
    expect(box()).toHaveValue('one\ntwo');
  });

  it('typing in a recalled message makes it the draft, so Down no longer steps', async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ headMessageId: 'a2' })} />);
    await user.click(box());
    await user.keyboard('{ArrowUp}');
    await user.keyboard('again: '); // the caret is at the start of a message recalled by Up
    expect(box()).toHaveValue('again: second');
    await user.keyboard('{ArrowDown}');
    expect(box()).toHaveValue('again: second');
  });

  it('a note that comes back while a recalled message shows goes after the real draft, not the recalled one', async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ headMessageId: 'a2' })} />);
    await user.type(box(), 'draft');
    await user.keyboard('{ArrowUp}');
    expect(box()).toHaveValue('second');
    const returned: ReplyNote = {
      id: 'n1', chatId: 'chat-1', text: 'came back', attachments: [], path: 'wait', replyIds: [], parentId: null, profileIds: ['p1'], clientId: CLIENT_ID, sentAt: 1,
    };
    act(() => {
      useOtherBenchStore.getState().applyChatEvent('chat-1', { type: 'note-resolved', chatId: 'chat-1', noteId: 'n1', outcome: 'returned', clientId: CLIENT_ID, note: returned });
    });

    await waitFor(() => expect(box()).toHaveValue('draft\n\ncame back'));
  });

  it('does nothing in a chat with no earlier messages', async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ id: 'chat-2' })} />);
    await user.click(box());
    await user.keyboard('{ArrowUp}');
    expect(box()).toHaveValue('');
  });
});

describe('Composer / command menu', () => {
  const conn = (id: string, kind: Connection['kind']): Connection => ({
    id, name: id, kind, baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null,
  });
  beforeEach(() => {
    reset();
    vi.mocked(api.chats.commands).mockReset();
    vi.mocked(api.chats.commands).mockResolvedValue({ commands: [...OWN_COMMANDS] });
    useOtherBenchStore.getState().setConnections([conn('cc', 'claude_code'), conn('oll', 'ollama')]);
    useOtherBenchStore.getState().setProfiles([
      makeProfile({ id: 'sonnet', name: 'Sonnet', connectionId: 'cc', modelId: 'sonnet' }),
      makeProfile({ id: 'qwen', name: 'Qwen', connectionId: 'oll', modelId: 'qwen3', isDefault: false }),
    ]);
  });
  afterEach(cleanup);
  const box = () => screen.getByRole('textbox', { name: /message/i });

  it('opens on / in a Claude Code chat; ArrowDown then Enter fills /compact and does not send, Enter again sends', async () => {
    mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
    mockedSetHead.mockResolvedValue(makeChat());
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    await user.type(box(), '/');
    expect(screen.getByRole('option', { name: /\/clear/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /\/compact/ })).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(box()).toHaveValue('/compact ');
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox', { name: 'Commands' })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mockedCreate).toHaveBeenCalled());
  });

  it('opens no menu in an API-only chat', async () => {
    await userEvent.setup().type((render(<Composer chat={makeChat({ profileId: 'qwen' })} />), box()), '/');
    expect(screen.queryByRole('listbox', { name: 'Commands' })).not.toBeInTheDocument();
  });

  it('Esc closes the menu and keeps the text', async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    await user.type(box(), '/co');
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Commands' })).not.toBeInTheDocument();
    expect(box()).toHaveValue('/co');
  });

  it('keeps focus in the box and points aria-activedescendant at the active option', async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    await user.type(box(), '/');
    expect(box()).toHaveFocus();
    const active = within(screen.getByRole('listbox', { name: 'Commands' })).getByRole('option', { selected: true });
    expect(box()).toHaveAttribute('aria-activedescendant', active.id);
    await user.keyboard('{ArrowDown}');
    expect(box()).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /\/compact/ }).id);
  });

  it('picking /clear leaves no trailing space and closes the menu; a space closes it too', async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    await user.type(box(), '/cl{Enter}');
    expect(box()).toHaveValue('/clear');
    expect(screen.queryByRole('listbox', { name: 'Commands' })).not.toBeInTheDocument();
    await user.clear(box());
    await user.type(box(), '/compact ');
    expect(screen.queryByRole('listbox', { name: 'Commands' })).not.toBeInTheDocument();
  });

  it('Enter on a typed /clear sends it at once; Tab still only fills', async () => {
    mockedCreate.mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: [] });
    mockedSetHead.mockResolvedValue(makeChat());
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    await user.type(box(), '/clear');
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument();
    await user.keyboard('{Tab}');
    expect(mockedCreate).not.toHaveBeenCalled();
    await user.clear(box());
    await user.type(box(), '/clear');
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith('chat-1', expect.objectContaining({ parts: [{ type: 'text', text: '/clear' }] })));
  });

  it('Enter on a typed /compact still fills it for a focus, without sending', async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    await user.type(box(), '/compact');
    await user.keyboard('{Enter}');
    expect(box()).toHaveValue('/compact ');
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('lists the fetched commands and shows the warning as a last row that is not an option', async () => {
    vi.mocked(api.chats.commands).mockResolvedValue({ commands: [{ name: 'clear', description: '', argumentHint: '', aliases: [] }, { name: 'deploy', description: 'Ship it', argumentHint: '', aliases: [] }], warning: "Couldn't load this chat's own commands." });
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    await user.type(box(), '/');
    expect(await screen.findByRole('option', { name: /\/deploy/ })).toBeInTheDocument();
    expect(vi.mocked(api.chats.commands)).toHaveBeenCalledWith('chat-1', 'sonnet');
    expect(screen.getByText("Couldn't load this chat's own commands.")).toBeInTheDocument();
    expect(within(screen.getByRole('listbox', { name: 'Commands' })).getAllByRole('option')).toHaveLength(2);
  });

  it('retries after a fetch was cut short by closing the menu before it answered', async () => {
    let release!: (v: { commands: CommandRow[] }) => void;
    vi.mocked(api.chats.commands).mockReturnValueOnce(new Promise((r) => (release = r)));
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    await user.type(box(), '/');
    await user.keyboard('{Escape}');
    release({ commands: [...OWN_COMMANDS, { name: 'deploy', description: '', argumentHint: '', aliases: [] }] });
    await user.clear(box());
    await user.type(box(), '/');
    expect(await screen.findByRole('option', { name: /\/deploy/ })).toBeInTheDocument();
  });

  it('shows each chat its own list when switching A to B and back', async () => {
    const cmd = (name: string): CommandRow => ({ name, description: '', argumentHint: '', aliases: [] });
    vi.mocked(api.chats.commands).mockImplementation(async (chatId) => ({ commands: [cmd(chatId === 'chat-1' ? 'alpha' : 'beta')] }));
    const user = userEvent.setup();
    const view = render(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    await user.type(box(), '/');
    expect(await screen.findByRole('option', { name: /\/alpha/ })).toBeInTheDocument();
    view.rerender(<Composer chat={makeChat({ id: 'chat-2', profileId: 'sonnet' })} />);
    expect(await screen.findByRole('option', { name: /\/beta/ })).toBeInTheDocument();
    view.rerender(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    expect(await screen.findByRole('option', { name: /\/alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /\/beta/ })).not.toBeInTheDocument();
  });

  it('keeps the built-ins and says so when the fetch fails', async () => {
    vi.mocked(api.chats.commands).mockRejectedValue(new Error('network'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    await user.type(box(), '/');
    expect(await screen.findByText("Couldn't load this chat's own commands.")).toBeInTheDocument();
    expect(within(screen.getByRole('listbox', { name: 'Commands' })).getAllByRole('option')).toHaveLength(2);
  });
});

describe('Composer while a reply runs (notes)', () => {
  const conn = (id: string, kind: Connection['kind']): Connection => ({
    id, name: id, kind, baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null,
  });
  const note = (id: string, over: Partial<ReplyNote> = {}): ReplyNote => ({
    id, chatId: 'chat-1', text: id, attachments: [], path: 'wait', replyIds: ['a1'], parentId: 'a1', profileIds: ['p1'], clientId: CLIENT_ID, sentAt: 1, ...over,
  });
  beforeEach(() => {
    reset();
    mockedAttachmentList.mockReset();
    mockedAttachmentList.mockResolvedValue([]);
    vi.mocked(api.chats.commands).mockReset();
    vi.mocked(api.chats.commands).mockResolvedValue({ commands: [...OWN_COMMANDS, { name: 'review', description: 'Review', argumentHint: '', aliases: [] }] });
    useOtherBenchStore.getState().setConnections([conn('c1', 'mock'), conn('cc', 'claude_code')]);
    useOtherBenchStore.getState().setProfiles([makeProfile(), makeProfile({ id: 'sonnet', name: 'Sonnet', connectionId: 'cc', modelId: 'sonnet', isDefault: false })]);
  });
  afterEach(cleanup);
  const box = () => screen.getByRole('textbox', { name: /message/i });

  it('shows Send and Stop while a reply runs', () => {
    useOtherBenchStore.getState().registerMessage(streamingMessage('a1'));
    render(<Composer chat={makeChat()} />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    cleanup();

    // Only notes waiting (the reply just ended): still busy, so Send sends a note, but there's nothing to stop.
    useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
    useOtherBenchStore.getState().setProfiles([makeProfile()]);
    useOtherBenchStore.getState().applyChatEvent('chat-1', { type: 'notes', chatId: 'chat-1', notes: [note('n1')] });
    render(<Composer chat={makeChat()} />);
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('Enter mid-reply sends a note and clears the box', async () => {
    useOtherBenchStore.getState().registerMessage(streamingMessage('a1'));
    mockedAttachmentList.mockResolvedValue([makeAttachment({ id: 'att-1' })]);
    const sent = note('n1', { text: 'one more thing' });
    mockedNoteSend.mockResolvedValue(sent);
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ headMessageId: 'u1' })} parentId="a1" />);
    await screen.findByText('photo.png');
    await user.type(box(), 'one more thing{Enter}');

    await waitFor(() => expect(box()).toHaveValue(''));
    expect(mockedNoteSend).toHaveBeenCalledWith('chat-1', { text: 'one more thing', attachments: [{ attachmentId: 'att-1' }], parentId: 'a1', profileIds: ['p1'], clientId: CLIENT_ID });
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('attachment-chip')).not.toBeInTheDocument();
    expect(useOtherBenchStore.getState().sentNotes['n1']).toEqual(sent);
  });

  it('a slash command mid-reply is refused with the copy and kept', async () => {
    useOtherBenchStore.getState().registerMessage(streamingMessage('a1'));
    const user = userEvent.setup();
    render(<Composer chat={makeChat({ profileId: 'sonnet' })} />);
    await user.type(box(), '/clear{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait for the reply to finish, or stop it, before sending a command.');
    expect(box()).toHaveValue('/clear');

    // A Claude Code command from the `/` menu, with its arguments.
    await user.clear(box());
    await user.type(box(), '/review the diff{Enter}');
    expect(box()).toHaveValue('/review the diff');
    expect(mockedNoteSend).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();

    // Plain text that starts with a slash is not a command.
    mockedNoteSend.mockResolvedValue(note('n1'));
    await user.clear(box());
    await user.type(box(), '/etc/hosts is wrong{Enter}');
    await waitFor(() => expect(mockedNoteSend).toHaveBeenCalled());
  });

  it('falls back to a normal send when the server says the chat is idle', async () => {
    useOtherBenchStore.getState().registerMessage(streamingMessage('a1'));
    mockedNoteSend.mockRejectedValue(new ApiError(409, 'Conflict', 'idle'));
    mockedCreate.mockResolvedValue({ userMessageId: 'u2', assistantMessageIds: ['a2'] });
    mockedSetHead.mockResolvedValue(makeChat());
    const user = userEvent.setup();
    render(<Composer chat={makeChat()} parentId="a1" />);
    await user.type(box(), 'just ended{Enter}');

    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith('chat-1', { parentId: 'a1', parts: [{ type: 'text', text: 'just ended' }], profileIds: ['p1'] }));
    await waitFor(() => expect(box()).toHaveValue(''));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("a returned note's text and chips come back after the draft", async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat()} />);
    await user.type(box(), 'my draft');
    const returned = note('n1', { text: 'came back', attachments: [{ attachmentId: 'att-9', mime: 'image/png', filename: 'shot.png' }] });
    act(() => {
      useOtherBenchStore.getState().noteSent(returned);
      useOtherBenchStore.getState().applyChatEvent('chat-1', { type: 'note-resolved', chatId: 'chat-1', noteId: 'n1', outcome: 'returned', clientId: CLIENT_ID, note: returned });
    });

    await waitFor(() => expect(box()).toHaveValue('my draft\n\ncame back'));
    expect(screen.getByText('shot.png')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent("Not sent: the reply ended before it was read. It's back in the box.");
    expect(useOtherBenchStore.getState().returnedNotes).toEqual([]);
  });

  it('a note returned with its chip while the send is still in flight keeps the chip and the notice', async () => {
    useOtherBenchStore.getState().registerMessage(streamingMessage('a1'));
    const returned = note('n1', { text: 'came back', attachments: [{ attachmentId: 'att-1', mime: 'image/png', filename: 'photo.png' }] });
    // The server returns the note (the reply just stopped) before the send's own response arrives.
    let respond!: (n: ReplyNote) => void;
    mockedNoteSend.mockImplementation(() => new Promise<ReplyNote>((resolve) => (respond = resolve)));
    mockedAttachmentList.mockResolvedValue([makeAttachment({ id: 'att-1' })]);
    const user = userEvent.setup();
    render(<Composer chat={makeChat()} />);
    await screen.findByText('photo.png');
    await user.type(box(), 'came back{Enter}');
    await waitFor(() => expect(mockedNoteSend).toHaveBeenCalled());

    act(() => {
      useOtherBenchStore.getState().applyChatEvent('chat-1', { type: 'note-resolved', chatId: 'chat-1', noteId: 'n1', outcome: 'returned', clientId: CLIENT_ID, note: returned });
    });
    await act(async () => respond(returned));

    await waitFor(() => expect(box()).toHaveValue('came back'));
    expect(screen.getByText('photo.png')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent("Not sent: the reply ended before it was read. It's back in the box.");
    expect(useOtherBenchStore.getState().sentNotes).toEqual({});
  });

  it('a note taken back comes back to the box without the not-sent copy', async () => {
    render(<Composer chat={makeChat()} />);
    act(() => useOtherBenchStore.getState().noteTakenBack(note('n1', { text: 'never mind' })));
    await waitFor(() => expect(box()).toHaveValue('never mind'));
    expect(screen.queryByText(/Not sent:/)).not.toBeInTheDocument();
  });
});

describe('Composer prefill (spec 2026-10-20-code-tab-design, Goal 7)', () => {
  const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: /message/i });
  beforeEach(() => {
    reset();
    useOtherBenchStore.getState().setProfiles([makeProfile()]);
    mockedAttachmentList.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('puts text handed to the chat in the box without sending it, once', async () => {
    useOtherBenchStore.getState().prefillComposer('chat-1', '#48 MCP tools vanish\nhttps://github.com/x/y/issues/48');
    render(<Composer chat={makeChat()} />);
    await waitFor(() => expect(box()).toHaveValue('#48 MCP tools vanish\nhttps://github.com/x/y/issues/48'));
    expect(useOtherBenchStore.getState().composerPrefills).toEqual({});
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedNoteSend).not.toHaveBeenCalled();
  });

  it('text handed over while the box has a draft goes after it', async () => {
    const user = userEvent.setup();
    render(<Composer chat={makeChat()} />);
    await user.type(box(), 'my draft');
    act(() => useOtherBenchStore.getState().prefillComposer('chat-1', 'from the issue'));
    await waitFor(() => expect(box()).toHaveValue('my draft\n\nfrom the issue'));
  });

  it("another chat's text stays where it is", async () => {
    useOtherBenchStore.getState().prefillComposer('chat-2', 'not mine');
    render(<Composer chat={makeChat()} />);
    expect(box()).toHaveValue('');
    expect(useOtherBenchStore.getState().composerPrefills).toEqual({ 'chat-2': 'not mine' });
  });
});
