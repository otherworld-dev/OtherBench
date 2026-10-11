import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@grunt/core/ports/store.js';
import type { Profile } from '@grunt/core/types/config.js';

vi.mock('../state/api.js', () => ({
  api: { chats: { create: vi.fn() }, attachments: { fromPath: vi.fn() } },
}));

import { api } from '../state/api.js';
import { useGruntStore } from '../state/store.js';
import { handleOpenArgs } from './useOpenArgs.js';

const mockedCreate = vi.mocked(api.chats.create);
const mockedFromPath = vi.mocked(api.attachments.fromPath);

const profile = (id: string, over: Partial<Profile> = {}): Profile => ({
  id, name: id, description: null, colour: null, connectionId: 'c', modelId: 'm', systemPrompt: null, params: {},
  toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null, ...over,
});

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return {
    id, title: 'New Chat', profileId: 'p-default', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, archivedAt: null, autoMode: false,
    projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('handleOpenArgs', () => {
  beforeEach(() => {
    useGruntStore.setState(useGruntStore.getInitialState(), true);
    useGruntStore.setState({ profiles: [profile('p-old', { archivedAt: 5, isDefault: true }), profile('p-other'), profile('p-default', { isDefault: true })] });
    mockedCreate.mockReset();
    mockedFromPath.mockReset();
  });

  it('--open-folder opens a new chat working in that folder, with the default profile', async () => {
    mockedCreate.mockResolvedValue(chat('c1', { workspaceRoot: 'E:\\Work' }));
    await handleOpenArgs(['grunt.exe', '--open-folder', 'E:\\Work']);
    expect(mockedCreate).toHaveBeenCalledWith({ profileId: 'p-default', workspaceRoot: 'E:\\Work' });
    expect(useGruntStore.getState().activeChatId).toBe('c1');
    expect(useGruntStore.getState().chats.map((c) => c.id)).toEqual(['c1']);
  });

  it('--send opens a new chat with each file attached, carrying on past one that fails', async () => {
    mockedCreate.mockResolvedValue(chat('c2'));
    mockedFromPath.mockRejectedValueOnce(new Error('not an image')).mockResolvedValue({} as never);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleOpenArgs(['grunt.exe', '--send', 'E:\\notes.txt', 'E:\\shot.png']);
    expect(mockedFromPath.mock.calls).toEqual([
      ['c2', 'E:\\notes.txt'],
      ['c2', 'E:\\shot.png'],
    ]);
    expect(useGruntStore.getState().activeChatId).toBe('c2');
    errors.mockRestore();
  });

  it('does nothing without arguments, or without a profile to use', async () => {
    await handleOpenArgs(['grunt.exe', '--minimized']);
    useGruntStore.setState({ profiles: [] });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleOpenArgs(['grunt.exe', '--open-folder', 'E:\\Work']);
    expect(mockedCreate).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
