import { describe, expect, it } from 'vitest';
import type { ProjectMemory } from '@otherbench/core/ports/store.js';
import { memoryUpdatedLine } from './memoryUpdated.js';

const NOW = 10_000_000;
const memory = (over: Partial<ProjectMemory>): ProjectMemory => ({ projectId: 'p1', body: '', updatedAt: 0, updatedBy: 'user', sourceChatId: null, ...over });

describe('memoryUpdatedLine', () => {
  it('says never saved, by you, or from which chat', () => {
    const chats = [{ id: 'c1', title: 'Build fix' }];
    expect(memoryUpdatedLine(memory({}), chats, NOW)).toBe('Not saved yet');
    expect(memoryUpdatedLine(memory({ updatedAt: NOW - 5 * 60_000 }), chats, NOW)).toBe('Updated 5 min ago by you');
    expect(memoryUpdatedLine(memory({ updatedAt: NOW - 5 * 60_000, updatedBy: 'summariser', sourceChatId: 'c1' }), chats, NOW)).toBe('Updated 5 min ago from Build fix');
    expect(memoryUpdatedLine(memory({ updatedAt: NOW - 5 * 60_000, updatedBy: 'summariser', sourceChatId: 'gone' }), chats, NOW)).toBe('Updated 5 min ago from a deleted chat');
    expect(memoryUpdatedLine(memory({ updatedAt: NOW - 5 * 60_000, updatedBy: 'summariser', sourceChatId: null }), chats, NOW)).toBe('Updated 5 min ago from a chat');
  });
});
