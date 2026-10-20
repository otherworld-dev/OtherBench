import { describe, expect, it, vi } from 'vitest';
import type { App, Chat, Project } from '@otherbench/core/ports/store.js';
import { appMenuItems, chatMenuItems, projectMenuItems, type ChatMenuHandlers, type ProjectMenuHandlers } from './menus.js';

function chat(over: Partial<Chat> = {}): Chat {
  return { id: 'c1', title: 'Chat', profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false, projectId: null, appId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}

function project(id: string, name: string): Project {
  return { id, name, description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };
}

function app(id: string, name: string): App {
  return { id, name, workspace: null, githubRepo: null, linkedProjectId: null, defaultProfileId: null, sortOrder: 0, createdAt: 1, updatedAt: 1 };
}

function chatHandlers(): ChatMenuHandlers {
  return { openInTab: vi.fn(), rename: vi.fn(), setPinned: vi.fn(), setProjectPinned: vi.fn(), reorder: vi.fn(), moveTo: vi.fn(), moveToNewProject: vi.fn(), moveToApp: vi.fn(), moveOutOfApp: vi.fn(), exportAs: vi.fn(), schedule: vi.fn(), setMemoryExcluded: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), requestDelete: vi.fn() };
}

describe('chatMenuItems and apps (spec 2026-10-20-code-tab-design, Goal 8)', () => {
  const apps = [app('A', 'Alpha'), app('B', 'Beta')];

  it('offers Move to app…, listing the apps, right after Move to project…, and selecting one moves the chat there', () => {
    const h = chatHandlers();
    const items = chatMenuItems(chat(), [], h, null, false, apps);
    expect(items.map((i) => i.label)).toEqual(['Open in new tab', 'Rename', 'Pin', 'Move to project…', 'Move to app…', "Don't add to memory", 'Schedule…', 'Export…', 'Archive', 'Delete…']);
    const submenu = items.find((i) => i.id === 'move-app')!.submenu!;
    expect(submenu.map((i) => i.label)).toEqual(['Alpha', 'Beta']);
    submenu[0]!.onSelect!();
    expect(h.moveToApp).toHaveBeenCalledWith('A');
  });

  it('has no Move to app… while there are no apps', () => {
    expect(chatMenuItems(chat(), [], chatHandlers()).some((i) => i.id === 'move-app')).toBe(false);
  });

  it('for an app chat, checks its app and adds Move out of app, which takes it out; Move to project… stays', () => {
    const h = chatHandlers();
    const items = chatMenuItems(chat({ appId: 'B' }), [project('p', 'P')], h, null, false, apps);
    expect(items.map((i) => i.label)).toEqual(['Open in new tab', 'Rename', 'Pin', 'Move to project…', 'Move to app…', 'Move out of app', "Don't add to memory", 'Schedule…', 'Export…', 'Archive', 'Delete…']);
    expect(items.find((i) => i.id === 'move-app')!.submenu!.map((i) => i.checked)).toEqual([false, true]);
    // An app chat isn't in No project: nothing in Move to project… is checked, and its No project entry takes it out of the app.
    const projectItems = items.find((i) => i.id === 'move')!.submenu!;
    expect(projectItems.filter((i) => i.checked)).toEqual([]);
    projectItems.find((i) => i.label === 'No project')!.onSelect!();
    expect(h.moveOutOfApp).toHaveBeenCalledTimes(1);
    expect(h.moveTo).not.toHaveBeenCalled();
    items.find((i) => i.id === 'move-out-app')!.onSelect!();
    expect(h.moveOutOfApp).toHaveBeenCalledTimes(2);
  });
});

describe('appMenuItems', () => {
  it('offers Rename, Edit… and Delete…, each calling its handler', () => {
    const h = { rename: vi.fn(), edit: vi.fn(), requestDelete: vi.fn() };
    const items = appMenuItems(h);
    expect(items.map((i) => i.label)).toEqual(['Rename', 'Edit…', 'Delete…']);
    expect(items[2]!.danger).toBe(true);
    for (const item of items) item.onSelect!();
    expect(h.rename).toHaveBeenCalled();
    expect(h.edit).toHaveBeenCalled();
    expect(h.requestDelete).toHaveBeenCalled();
  });
});

describe('chatMenuItems', () => {
  it('offers Open in new tab (Go to tab once open), Rename, Pin, Move to project…, Archive and Delete…, and Unpin for a pinned chat', () => {
    expect(chatMenuItems(chat(), [], chatHandlers(), null, true)[0]!.label).toBe('Go to tab');
    expect(chatMenuItems(chat(), [], chatHandlers()).map((i) => i.label)).toEqual(['Open in new tab', 'Rename', 'Pin', 'Move to project…', "Don't add to memory", 'Schedule…', 'Export…', 'Archive', 'Delete…']);
    expect(chatMenuItems(chat({ pinned: true }), [], chatHandlers()).find((i) => i.id === 'pin')!.label).toBe('Unpin');
  });

  it("offers Don't add to memory after Move to project… for a chat in a project, and Add to memory once it's excluded", () => {
    const projects = [project('a', 'Alpha')];
    const h = chatHandlers();

    const items = chatMenuItems(chat({ projectId: 'a' }), projects, h);
    expect(items.map((i) => i.label)).toEqual(['Open in new tab', 'Rename', 'Pin', 'Pin in project', 'Move to project…', "Don't add to memory", 'Schedule…', 'Export…', 'Archive', 'Delete…']);
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
    expect(middle.map((i) => i.label)).toEqual(['Open in new tab', 'Rename', 'Pin', 'Move up', 'Move down', 'Move to project…', "Don't add to memory", 'Schedule…', 'Export…', 'Archive', 'Delete…']);
    middle.find((i) => i.id === 'up')!.onSelect!();
    expect(h.reorder).toHaveBeenLastCalledWith(-1);
    middle.find((i) => i.id === 'down')!.onSelect!();
    expect(h.reorder).toHaveBeenLastCalledWith(1);

    expect(chatMenuItems(chat(), [], h, { index: 0, count: 3 }).find((i) => i.id === 'up')!.disabled).toBe(true);
    expect(chatMenuItems(chat(), [], h, { index: 2, count: 3 }).find((i) => i.id === 'down')!.disabled).toBe(true);
    expect(chatMenuItems(chat(), [], h).some((i) => i.id === 'up' || i.id === 'down')).toBe(false);
  });

  it('offers Schedule… for a chat that is not archived, and it calls schedule', () => {
    const h = chatHandlers();
    chatMenuItems(chat(), [], h).find((i) => i.id === 'schedule')!.onSelect!();
    expect(h.schedule).toHaveBeenCalled();
    expect(chatMenuItems(chat({ archivedAt: 5 }), [], h).some((i) => i.id === 'schedule')).toBe(false);
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

  it('offers Pin in project for a chat in a listed project, Unpin from project once pinned there, and sets the opposite state', () => {
    const projects = [project('a', 'Alpha')];
    const h = chatHandlers();
    chatMenuItems(chat({ projectId: 'a' }), projects, h).find((i) => i.id === 'project-pin')!.onSelect!();
    expect(h.setProjectPinned).toHaveBeenLastCalledWith(true);
    const pinned = chatMenuItems(chat({ projectId: 'a', projectPinned: true }), projects, h).find((i) => i.id === 'project-pin')!;
    expect(pinned.label).toBe('Unpin from project');
    pinned.onSelect!();
    expect(h.setProjectPinned).toHaveBeenLastCalledWith(false);
  });

  it('has no Pin in project for a chat outside a listed project, or an archived one', () => {
    const projects = [project('a', 'Alpha')];
    for (const c of [chat(), chat({ projectId: 'gone' }), chat({ projectId: 'a', archivedAt: 5 })]) {
      expect(chatMenuItems(c, projects, chatHandlers()).some((i) => i.id === 'project-pin')).toBe(false);
    }
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
  const h = (): ProjectMenuHandlers => ({ rename: vi.fn(), settings: vi.fn(), schedule: vi.fn(), move: vi.fn(), setSort: vi.fn(), newSubProject: vi.fn(), moveUnder: vi.fn(), requestDelete: vi.fn() });
  const top = { parentId: null, candidates: [], hasChildren: false };

  it('offers the project actions, with Move up disabled first and Move down disabled last', () => {
    const first = projectMenuItems(0, 3, 'manual', h(), top);
    expect(first.map((i) => i.label)).toEqual(['Rename', 'Project settings…', 'New sub-project…', 'Schedule…', 'Sort by recent activity', 'Move under…', 'Move up', 'Move down', 'Delete…']);
    expect(first.find((i) => i.id === 'up')!.disabled).toBe(true);
    expect(first.find((i) => i.id === 'down')!.disabled).toBe(false);
    expect(projectMenuItems(2, 3, 'manual', h(), top).find((i) => i.id === 'down')!.disabled).toBe(true);
  });

  it('offers Schedule…, which calls schedule', () => {
    const handlers = h();
    projectMenuItems(0, 1, 'manual', handlers, top).find((i) => i.id === 'schedule')!.onSelect!();
    expect(handlers.schedule).toHaveBeenCalled();
  });

  it('Move up and Move down call move with the direction', () => {
    const handlers = h();
    const items = projectMenuItems(1, 3, 'manual', handlers, top);
    items.find((i) => i.id === 'up')!.onSelect!();
    items.find((i) => i.id === 'down')!.onSelect!();
    expect(handlers.move).toHaveBeenNthCalledWith(1, -1);
    expect(handlers.move).toHaveBeenNthCalledWith(2, 1);
  });

  it('switches the sort to the other one', () => {
    const handlers = h();
    projectMenuItems(0, 1, 'manual', handlers, top).find((i) => i.id === 'sort')!.onSelect!();
    const recent = projectMenuItems(0, 1, 'recent', handlers, top).find((i) => i.id === 'sort')!;
    expect(recent.label).toBe('Sort manually');
    recent.onSelect!();
    expect(handlers.setSort).toHaveBeenNthCalledWith(1, 'recent');
    expect(handlers.setSort).toHaveBeenNthCalledWith(2, 'manual');
  });

  it('offers Move under… with Top level and the other top-level projects, the current one checked', () => {
    const handlers = h();
    const items = projectMenuItems(0, 1, 'manual', handlers, { parentId: 'a', candidates: [project('a', 'Alpha'), project('b', 'Beta')], hasChildren: false });
    const under = items.find((i) => i.id === 'move-under')!;
    expect(under.submenu!.map((i) => [i.label, i.checked])).toEqual([
      ['Top level', false],
      ['Alpha', true],
      ['Beta', false],
    ]);
    under.submenu![0]!.onSelect!();
    under.submenu![2]!.onSelect!();
    expect(handlers.moveUnder).toHaveBeenNthCalledWith(1, null);
    expect(handlers.moveUnder).toHaveBeenNthCalledWith(2, 'b');
    // A sub-project can't have sub-projects of its own.
    expect(items.find((i) => i.id === 'new-sub')).toBeUndefined();
  });

  it('leaves Move under… out for a project with sub-projects, and New sub-project… opens the page', () => {
    const handlers = h();
    const items = projectMenuItems(0, 1, 'manual', handlers, { ...top, hasChildren: true });
    expect(items.find((i) => i.id === 'move-under')).toBeUndefined();
    items.find((i) => i.id === 'new-sub')!.onSelect!();
    expect(handlers.newSubProject).toHaveBeenCalled();
  });
});
