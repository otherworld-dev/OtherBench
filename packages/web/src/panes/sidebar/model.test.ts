import { describe, expect, it } from 'vitest';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import { NO_PROJECT_KEY } from '../../state/sidebarGroups.js';
import { buildSidebar, moveProjectPatches } from './model.js';

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return { id, title: id, profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, autoMode: false, projectId: null, memoryCursor: null, memoryExcluded: false, createdAt: 1, updatedAt: 1, ...over };
}

function project(id: string, name: string, sortOrder = 0): Project {
  return { id, name, workspaceRoot: null, defaultProfileId: null, sortOrder, createdAt: 1, updatedAt: 1 };
}

const ids = (chats: Chat[]): string[] => chats.map((c) => c.id);

describe('buildSidebar', () => {
  it('orders project groups by sortOrder then name, with No project last', () => {
    const model = buildSidebar([], [project('b', 'beta', 1), project('a', 'Alpha', 1), project('z', 'Zed', 0)], null);
    expect(model.groups.map((g) => g.key)).toEqual(['z', 'a', 'b', NO_PROJECT_KEY]);
    expect(model.groups.at(-1)!.project).toBeNull();
  });

  it('leaves archived chats out of the groups and shows pinned chats only under Pinned, while still counting them in their project', () => {
    const model = buildSidebar(
      [chat('pinned', { projectId: 'a', pinned: true }), chat('plain', { projectId: 'a' }), chat('archived', { projectId: 'a', archivedAt: 5 })],
      [project('a', 'Alpha')],
      null
    );
    expect(ids(model.pinned)).toEqual(['pinned']);
    expect(ids(model.groups[0]!.chats)).toEqual(['plain']);
    expect(model.groups[0]!.total).toBe(2);
  });

  it('returns archived chats in a separate list, newest activity first, filtered by search (controller ruling R2)', () => {
    const chats = [
      chat('old', { archivedAt: 5, updatedAt: 1, projectId: 'a' }),
      chat('new', { archivedAt: 6, updatedAt: 9, pinned: true }),
      chat('live'),
    ];
    expect(ids(buildSidebar(chats, [project('a', 'Alpha')], null).archived)).toEqual(['new', 'old']);
    expect(ids(buildSidebar(chats, [project('a', 'Alpha')], new Set(['old', 'live'])).archived)).toEqual(['old']);
    expect(buildSidebar([chat('live')], [], null).archived).toEqual([]);
  });

  it('puts a chat whose project is not loaded under No project (review focus 5)', () => {
    const model = buildSidebar([chat('orphan', { projectId: 'gone' })], [project('a', 'Alpha')], null);
    expect(ids(model.groups.find((g) => g.key === NO_PROJECT_KEY)!.chats)).toEqual(['orphan']);
    expect(model.groups.find((g) => g.key === 'a')!.total).toBe(0);
  });

  it('sorts every list newest activity first', () => {
    const model = buildSidebar([chat('old', { updatedAt: 1 }), chat('new', { updatedAt: 9 }), chat('mid', { updatedAt: 5 })], [], null);
    expect(ids(model.groups[0]!.chats)).toEqual(['new', 'mid', 'old']);
  });

  it('while searching, filters every list to the matches and drops groups left with none', () => {
    const model = buildSidebar(
      [chat('a1', { projectId: 'a' }), chat('b1', { projectId: 'b' }), chat('b2', { projectId: 'b', pinned: true }), chat('loose')],
      [project('a', 'Alpha'), project('b', 'Beta')],
      new Set(['b1', 'b2'])
    );
    expect(ids(model.pinned)).toEqual(['b2']);
    expect(model.groups.map((g) => g.key)).toEqual(['b']);
    expect(ids(model.groups[0]!.chats)).toEqual(['b1']);
  });
});

describe('moveProjectPatches', () => {
  it('swaps a project with its neighbour', () => {
    const ps = [project('a', 'A', 0), project('b', 'B', 1), project('c', 'C', 2)];
    expect(moveProjectPatches(ps, 'a', 1)).toEqual([
      { id: 'b', sortOrder: 0 },
      { id: 'a', sortOrder: 1 },
    ]);
    expect(moveProjectPatches(ps, 'c', -1)).toEqual([
      { id: 'c', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
    ]);
  });

  it('returns nothing at either end or for an unknown id', () => {
    const ps = [project('a', 'A', 0), project('b', 'B', 1)];
    expect(moveProjectPatches(ps, 'a', -1)).toEqual([]);
    expect(moveProjectPatches(ps, 'b', 1)).toEqual([]);
    expect(moveProjectPatches(ps, 'nope', 1)).toEqual([]);
  });

  it('renumbers projects that share a sortOrder, so a move always takes effect', () => {
    const ps = [project('a', 'A', 0), project('b', 'B', 0), project('c', 'C', 0)];
    expect(moveProjectPatches(ps, 'c', -1)).toEqual([
      { id: 'c', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
    ]);
  });
});
