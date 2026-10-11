import { describe, expect, it, vi } from 'vitest';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import { chatMenuItems, projectMenuItems, type ChatMenuHandlers, type ProjectMenuHandlers } from './menus.js';

function chat(over: Partial<Chat> = {}): Chat {
  return { id: 'c1', title: 'Chat', profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, archivedAt: null, autoMode: false, projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}

function project(id: string, name: string): Project {
  return { id, name, description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };
}

function chatHandlers(): ChatMenuHandlers {
  return { openInTab: vi.fn(), rename: vi.fn(), setPinned: vi.fn(), reorder: vi.fn(), moveTo: vi.fn(), moveToNewProject: vi.fn(), exportAs: vi.fn(), setMemoryExcluded: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), requestDelete: vi.fn() };
}

describe('chatMenuItems', () => {
  it('offers Open in new tab (Go to tab once open), Rename, Pin, Move to project…, Archive and Delete…, and Unpin for a pinned chat', () => {
    expect(chatMenuItems(chat(), [], chatHandlers(), null, true)[0]!.label).toBe('Go to tab');
    expect(chatMenuItems(chat(), [], chatHandlers()).map((i) => i.label)).toEqual(['Open in new tab', 'Rename', 'Pin', 'Move to project…', "Don't add to memory", 'Export…', 'Archive', 'Delete…']);
    expect(chatMenuItems(chat({ pinned: true }), [], chatHandlers()).find((i) => i.id === 'pin')!.label).toBe('Unpin');
  });

  it("offers Don't add to memory after Move to project… for a chat in a project, and Add to memory once it's excluded", () => {
    const projects = [project('a', 'Alpha')];
    const h = chatHandlers();

    const items = chatMenuItems(chat({ projectId: 'a' }), projects, h);
    expect(items.map((i) => i.label)).toEqual(['Open in new tab', 'Rename', 'Pin', 'Move to project…', "Don't add to memory", 'Export…', 'Archive', 'Delete…']);
    items.find((i) => i.id === 'memory')!.onSelect!();
    expect(h.setMemoryExcluded).toHaveBeenLastCalledWith(true);

    const excluded = chatMenuItems(chat({ projectId: 'a', memoryExcluded: true }), projects, h).find((i) => i.id === 'memory')!;
    expect(excluded.label).toBe('Add to memory');
    excluded.onSelect!();
    expect(h.setMemoryExcluded).toHaveBeenLastCalledWith(false);
  });

  it('offers the memory item on a chat outside any project too, since it feeds the global note', () => {
    expect(chatMenuItems(chat(), [project('a', 'Alpha')], chatHandlers()).find((i) => i.id === 'memory')!.label).toBe("Don't add to memory");
    expect(chatMenuItems(chat({ projectId: 'gone' }), [project('a', 'Alpha')], chatHandlers()).some((i) => i.id === 'memory')).toBe(true);
  });

  it('offers Unarchive instead of Archive for an archived chat, and it calls unarchive, not archive (controller ruling R2)', () => {
    const h = chatHandlers();
    const items = chatMenuItems(chat({ archivedAt: 5 }), [], h);
    expect(items.map((i) => i.label)).toEqual(['Open in new tab', 'Rename', 'Move to project…', "Don't add to memory", 'Export…', 'Unarchive', 'Delete…']);
    items.find((i) => i.label === 'Unarchive')!.onSelect!();
    expect(h.unarchive).toHaveBeenCalled();
    expect(h.archive).not.toHaveBeenCalled();
  });

  it('offers Move up and Move down after Pin when given the chat\'s place, disabled at the ends', () => {
    const h = chatHandlers();
    const middle = chatMenuItems(chat(), [], h, { index: 1, count: 3 });
    expect(middle.map((i) => i.label)).toEqual(['Open in new tab', 'Rename', 'Pin', 'Move up', 'Move down', 'Move to project…', "Don't add to memory", 'Export…', 'Archive', 'Delete…']);
    middle.find((i) => i.id === 'up')!.onSelect!();
    expect(h.reorder).toHaveBeenLastCalledWith(-1);
    middle.find((i) => i.id === 'down')!.onSelect!();
    expect(h.reorder).toHaveBeenLastCalledWith(1);

    expect(chatMenuItems(chat(), [], h, { index: 0, count: 3 }).find((i) => i.id === 'up')!.disabled).toBe(true);
    expect(chatMenuItems(chat(), [], h, { index: 2, count: 3 }).find((i) => i.id === 'down')!.disabled).toBe(true);
    expect(chatMenuItems(chat(), [], h).some((i) => i.id === 'up' || i.id === 'down')).toBe(false);
  });

  it('Export… offers Markdown and JSON and passes the format on', () => {
    const h = chatHandlers();
    const exportItem = chatMenuItems(chat(), [], h).find((i) => i.id === 'export')!;
    expect(exportItem.submenu!.map((i) => i.label)).toEqual(['Markdown (shown conversation)', 'JSON (every branch)']);
    exportItem.submenu![0]!.onSelect!();
    expect(h.exportAs).toHaveBeenLastCalledWith('markdown');
    exportItem.submenu![1]!.onSelect!();
    expect(h.exportAs).toHaveBeenLastCalledWith('json');
  });

  it('hides Pin and Unpin for an archived chat', () => {
    expect(chatMenuItems(chat({ archivedAt: 5 }), [], chatHandlers()).some((i) => i.id === 'pin')).toBe(false);
    expect(chatMenuItems(chat({ archivedAt: 5, pinned: true }), [], chatHandlers()).some((i) => i.id === 'pin')).toBe(false);
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
      ['New project…', undefined],
    ]);
    move.submenu![0]!.onSelect!();
    move.submenu![2]!.onSelect!();
    expect(h.moveTo).toHaveBeenNthCalledWith(1, 'a');
    expect(h.moveTo).toHaveBeenNthCalledWith(2, null);
    move.submenu![3]!.onSelect!();
    expect(h.moveToNewProject).toHaveBeenCalled();
  });

  it('marks No project when the chat has none, or its project is not in the list', () => {
    const noProject = chatMenuItems(chat(), [project('a', 'Alpha')], chatHandlers()).find((i) => i.id === 'move')!;
    const orphan = chatMenuItems(chat({ projectId: 'gone' }), [project('a', 'Alpha')], chatHandlers()).find((i) => i.id === 'move')!;
    expect(noProject.submenu!.find((i) => i.label === 'No project')!.checked).toBe(true);
    expect(orphan.submenu!.map((i) => i.checked)).toEqual([false, true, undefined]);
  });
});

describe('projectMenuItems', () => {
  const h = (): ProjectMenuHandlers => ({ rename: vi.fn(), settings: vi.fn(), move: vi.fn(), requestDelete: vi.fn() });

  it('offers the project actions, with Move up disabled first and Move down disabled last', () => {
    const first = projectMenuItems(0, 3, h());
    expect(first.map((i) => i.label)).toEqual(['Rename', 'Project settings…', 'Move up', 'Move down', 'Delete…']);
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
