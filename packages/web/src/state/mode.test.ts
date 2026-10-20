import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat } from '@otherbench/core/ports/store.js';
import { loadMode, MODE_STORAGE_KEY, modeOfChat, saveMode } from './mode.js';

const chat = (appId: string | null): Chat => ({
  id: 'c1', title: 'Hello', profileId: 'p1', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false,
  unread: false, autoMode: false, projectId: null, appId, memoryCursor: null, memoryExcluded: false, sortOrder: 0, archivedAt: null, createdAt: 1, updatedAt: 1,
});

describe('mode', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('an app chat is a Code mode chat, any other is a Chat mode chat', () => {
    expect(modeOfChat(chat('a1'))).toBe('code');
    expect(modeOfChat(chat(null))).toBe('chat');
  });

  it('round-trips through storage, and anything else stored reads as chat', () => {
    expect(loadMode()).toBe('chat');
    saveMode('code');
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe('code');
    expect(loadMode()).toBe('code');
    saveMode('chat');
    expect(loadMode()).toBe('chat');
    window.localStorage.setItem(MODE_STORAGE_KEY, 'mosaic');
    expect(loadMode()).toBe('chat');
  });

  it('blocked storage reads as chat and a save is a no-op, never a throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadMode()).toBe('chat');
    expect(() => saveMode('code')).not.toThrow();
  });
});
