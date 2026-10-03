import { describe, expect, it, vi } from 'vitest';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import { chatMenuItems, projectMenuItems, type ChatMenuHandlers, type ProjectMenuHandlers } from './menus.js';

function chat(over: Partial<Chat> = {}): Chat {
  return { id: 'c1', title: 'Chat', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, autoMode: false, projectId: null, createdAt: 1, updatedAt: 1, ...over };
}

function project(id: string, name: string): Project {
  return { id, name, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };
}

function chatHandlers(): ChatMenuHandlers {
  return { rename: vi.fn(), setPinned: vi.fn(), moveTo: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), requestDelete: vi.fn() };
}

describe('chatMenuItems', () => {
  it('offers Rename, Pin, Move to project…, Archive and Delete…, and Unpin for a pinned chat', () => {
    expect(chatMenuItems(chat(), [], chatHandlers()).map((i) => i.label)).toEqual(['Rename', 'Pin', 'Move to project…', 'Archive', 'Delete…']);
    expect(chatMenuItems(chat({ pinned: true }), [], chatHandlers())[1]!.label).toBe('Unpin');
  });

  it('offers Unarchive instead of Archive for an archived chat, and it calls unarchive, not archive (controller ruling R2)', () => {
    const h = chatHandlers();
    const items = chatMenuItems(chat({ archivedAt: 5 }), [], h);
    expect(items.map((i) => i.label)).toEqual(['Rename', 'Pin', 'Move to project…', 'Unarchive', 'Delete…']);
    items.find((i) => i.label === 'Unarchive')!.onSelect!();
    expect(h.unarchive).toHaveBeenCalled();
    expect(h.archive).not.toHaveBeenCalled();
  });

  it('Pin and Unpin set the state opposite to the chat the menu was built with', () => {
    const h = chatHandlers();
    chatMenuItems(chat(), [], h).find((i) => i.id === 'pin')!.onSelect!();
    expect(h.setPinned).toHaveBeenLastCalledWith(true);
    chatMenuItems(chat({ pinned: true }), [], h).find((i) => i.id === 'pin')!.onSelect!();
    expect(h.setPinned).toHaveBeenLastCalledWith(false);
  });

  it("lists the projects in the given order plus No project, marking the chat's current one", () => {
    const h = chatHandlers();
    const move = chatMenuItems(chat({ projectId: 'b' }), [project('a', 'Alpha'), project('b', 'Beta')], h).find((i) => i.id === 'move')!;

    expect(move.submenu!.map((i) => [i.label, i.checked])).toEqual([
      ['Alpha', false],
      ['Beta', true],
      ['No project', false],
    ]);
    move.submenu![0]!.onSelect!();
    move.submenu![2]!.onSelect!();
    expect(h.moveTo).toHaveBeenNthCalledWith(1, 'a');
    expect(h.moveTo).toHaveBeenNthCalledWith(2, null);
  });

  it('marks No project when the chat has none, or its project is not in the list', () => {
    const noProject = chatMenuItems(chat(), [project('a', 'Alpha')], chatHandlers()).find((i) => i.id === 'move')!;
    const orphan = chatMenuItems(chat({ projectId: 'gone' }), [project('a', 'Alpha')], chatHandlers()).find((i) => i.id === 'move')!;
    expect(noProject.submenu!.at(-1)!.checked).toBe(true);
    expect(orphan.submenu!.map((i) => i.checked)).toEqual([false, true]);
  });
});

describe('projectMenuItems', () => {
  const h = (): ProjectMenuHandlers => ({ rename: vi.fn(), setFolder: vi.fn(), setDefaultProfile: vi.fn(), move: vi.fn(), requestDelete: vi.fn() });

  it('offers the project actions, with Move up disabled first and Move down disabled last', () => {
    const first = projectMenuItems(0, 3, h());
    expect(first.map((i) => i.label)).toEqual(['Rename', 'Set folder…', 'Default profile…', 'Move up', 'Move down', 'Delete…']);
    expect(first.find((i) => i.id === 'up')!.disabled).toBe(true);
    expect(first.find((i) => i.id === 'down')!.disabled).toBe(false);
    expect(projectMenuItems(2, 3, h()).find((i) => i.id === 'down')!.disabled).toBe(true);
  });

  it('Move up and Move down call move with the direction', () => {
    const handlers = h();
    const items = projectMenuItems(1, 3, handlers);
    items.find((i) => i.id === 'up')!.onSelect!();
    items.find((i) => i.id === 'down')!.onSelect!();
    expect(handlers.move).toHaveBeenNthCalledWith(1, -1);
    expect(handlers.move).toHaveBeenNthCalledWith(2, 1);
  });
});
