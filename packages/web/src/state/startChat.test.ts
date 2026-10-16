import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';

vi.mock('./api.js', () => ({
  api: { chats: { create: vi.fn() }, turns: { create: vi.fn() } },
  ApiError: class ApiError extends Error {},
}));

import { api } from './api.js';
import { StartChatError, startChat } from './startChat.js';
import { useOtherBenchStore } from './store.js';

const profile = (id: string): Profile => ({
  id, name: `Profile ${id}`, description: null, colour: null, connectionId: 'c', modelId: 'm', systemPrompt: null, params: {},
  toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null,
});
const chat = (id: string, over: Partial<Chat> = {}): Chat => ({
  id, title: 'New Chat', profileId: 'p-project', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: 'proj', memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useOtherBenchStore.setState(useOtherBenchStore.getInitialState(), true);
  useOtherBenchStore.setState({ profiles: [profile('p-project')] });
});

describe('startChat', () => {
  it("creates the chat in the project, adds it, sends with the chat's own profile, and registers both stubs", async () => {
    vi.mocked(api.chats.create).mockResolvedValue(chat('c1'));
    vi.mocked(api.turns.create).mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });

    const result = await startChat({ projectId: 'proj', text: 'hello' });

    expect(result.id).toBe('c1');
    expect(api.chats.create).toHaveBeenCalledWith({ projectId: 'proj' });
    expect(api.turns.create).toHaveBeenCalledWith('c1', { parentId: null, parts: [{ type: 'text', text: 'hello' }], profileIds: ['p-project'] });
    const state = useOtherBenchStore.getState();
    expect(state.chats.map((c) => c.id)).toEqual(['c1']);
    expect(state.messages['u1']).toMatchObject({ role: 'user', chatId: 'c1', parentId: null });
    expect(state.messages['a1']).toMatchObject({ role: 'assistant', parentId: 'u1', producedBy: { profileId: 'p-project' } });
  });

  it('sends into a given chat without creating another', async () => {
    vi.mocked(api.turns.create).mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
    await startChat({ chat: chat('c1'), text: 'again' });
    expect(api.chats.create).not.toHaveBeenCalled();
    expect(api.turns.create).toHaveBeenCalledWith('c1', expect.objectContaining({ parentId: null }));
  });

  it('throws StartChatError carrying the chat when the message fails after the chat was made', async () => {
    const cause = new Error('boom');
    vi.mocked(api.chats.create).mockResolvedValue(chat('c1'));
    vi.mocked(api.turns.create).mockRejectedValue(cause);

    const err = await startChat({ projectId: 'proj', text: 'hello' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StartChatError);
    expect((err as StartChatError).chat.id).toBe('c1');
    expect((err as StartChatError).cause).toBe(cause);
    expect(useOtherBenchStore.getState().chats.map((c) => c.id)).toEqual(['c1']);
  });

  it("still returns the chat when the message went but its local stubs couldn't be added, so a retry doesn't send it twice", async () => {
    vi.mocked(api.chats.create).mockResolvedValue(chat('c1'));
    vi.mocked(api.turns.create).mockResolvedValue({ userMessageId: 'u1', assistantMessageIds: ['a1'] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    useOtherBenchStore.setState({
      registerMessage: () => {
        throw new Error('stub trouble');
      },
    });

    await expect(startChat({ projectId: 'proj', text: 'hello' })).resolves.toMatchObject({ id: 'c1' });
    expect(api.turns.create).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it('rethrows a failed create as it is, with no chat to carry', async () => {
    const cause = new Error('no profile');
    vi.mocked(api.chats.create).mockRejectedValue(cause);
    await expect(startChat({ projectId: 'proj', text: 'hello' })).rejects.toBe(cause);
    expect(api.turns.create).not.toHaveBeenCalled();
  });
});
