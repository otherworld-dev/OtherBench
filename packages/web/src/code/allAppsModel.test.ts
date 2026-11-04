import { describe, expect, it } from 'vitest';
import type { App, AppFolder, Chat } from '@otherbench/core/ports/store.js';
import { allAppsSections } from './allAppsModel.js';

const app = (id: string, over: Partial<App> = {}): App => ({
  id, name: id, workspace: null, workspaceRoot: `E:/Git/${id}`, githubRepo: null, linkedProjectId: null, defaultProfileId: null, deckBoardId: null, wikiCollective: null, wikiPagePath: null, bookmarkTag: null, folderId: null, open: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});
const folder = (id: string, name: string, sortOrder = 0): AppFolder => ({ id, name, sortOrder, createdAt: 1, updatedAt: 1 });
const chat = (id: string, appId: string, over: Partial<Chat> = {}): Chat => ({
  id, title: id, profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false,
  projectId: null, appId, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
});

describe('allAppsSections', () => {
  it('lists folders in order, then Unfiled, apps in compareApps order', () => {
    const s = allAppsSections(
      [app('b', { folderId: 'f1', sortOrder: 1 }), app('a', { folderId: 'f1', sortOrder: 0 }), app('u'), app('g', { folderId: 'f2' })],
      [folder('f2', 'Games', 1), folder('f1', 'Business', 0)],
      [],
      ''
    );
    expect(s.map((x) => x.key)).toEqual(['folder:f1', 'folder:f2', 'folder:unfiled']);
    expect(s[0]!.cards.map((c) => c.app.id)).toEqual(['a', 'b']);
    expect(s[2]!.folder).toBeNull();
  });

  it("puts an app whose folder isn't loaded in Unfiled", () => {
    const s = allAppsSections([app('a', { folderId: 'gone' })], [], [], '');
    expect(s).toHaveLength(1);
    expect(s[0]!.key).toBe('folder:unfiled');
  });

  it('leaves Unfiled out when empty and keeps an empty folder', () => {
    const s = allAppsSections([], [folder('f1', 'Empty')], [], '');
    expect(s.map((x) => [x.key, x.cards.length, x.total])).toEqual([['folder:f1', 0, 0]]);
  });

  it('matches the query against app name, workspace path or folder name and drops sections with no match', () => {
    const apps = [app('alpha', { folderId: 'f1' }), app('beta', { folderId: 'f2', workspaceRoot: 'E:/Work/needle' }), app('gamma', { folderId: 'f3' })];
    const folders = [folder('f1', 'Business', 0), folder('f2', 'Games', 1), folder('f3', 'PhD', 2)];
    expect(allAppsSections(apps, folders, [], 'ALPH').map((s) => s.key)).toEqual(['folder:f1']);
    expect(allAppsSections(apps, folders, [], 'needle').flatMap((s) => s.cards.map((c) => c.app.id))).toEqual(['beta']);
    const byFolder = allAppsSections(apps, folders, [], 'phd');
    expect(byFolder.map((s) => s.key)).toEqual(['folder:f3']);
    expect(byFolder[0]!.cards.map((c) => c.app.id)).toEqual(['gamma']);
    expect(allAppsSections(apps, folders, [], 'zzz')).toEqual([]);
  });

  it("takes lastUsed from the latest unarchived chat's updatedAt", () => {
    const s = allAppsSections(
      [app('a'), app('b')],
      [],
      [chat('c1', 'a', { updatedAt: 5 }), chat('c2', 'a', { updatedAt: 9 }), chat('c3', 'a', { updatedAt: 99, archivedAt: 100 })],
      ''
    );
    const [a, b] = s[0]!.cards;
    expect(a!.lastUsed).toBe(9);
    expect(a!.chatCount).toBe(2);
    expect(b!.lastUsed).toBeNull();
    expect(b!.chatCount).toBe(0);
  });
});
