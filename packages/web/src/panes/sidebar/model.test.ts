import { describe, expect, it } from 'vitest';
import type { Chat, Project } from '@grunt/core/ports/store.js';
import { NO_PROJECT_KEY } from '../../state/sidebarGroups.js';
import { buildSidebar, moveProjectPatches, moveTarget, placeChatPatches } from './model.js';

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return { id, title: id, profileId: 'p', headMessageId: null, workspace: null, runsOn: 'node-self', workspaceRoot: null, pinned: false, projectPinned: false, unread: false, archivedAt: null, autoMode: false, projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over };
}

function project(id: string, name: string, sortOrder = 0): Project {
  return { id, name, description: '', instructions: '', workspace: null, workspaceRoot: null, defaultProfileId: null, sortOrder, createdAt: 1, updatedAt: 1 };
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

  it("lists a project's pinned chats first, apart from the rest; a globally pinned chat stays under Pinned; No project ignores the flag", () => {
    const model = buildSidebar(
      [
        chat('plain', { projectId: 'a', sortOrder: 9 }),
        chat('kept-low', { projectId: 'a', projectPinned: true, sortOrder: 1 }),
        chat('kept-high', { projectId: 'a', projectPinned: true, sortOrder: 2 }),
        chat('both', { projectId: 'a', projectPinned: true, pinned: true }),
        chat('loose', { projectPinned: true }), // its project was deleted
      ],
      [project('a', 'Alpha')],
      null
    );
    const alpha = model.groups[0]!;
    expect(ids(alpha.pinnedChats)).toEqual(['kept-high', 'kept-low']);
    expect(ids(alpha.chats)).toEqual(['plain']);
    expect(alpha.total).toBe(4);
    expect(ids(model.pinned)).toEqual(['both']);
    const none = model.groups.at(-1)!;
    expect(ids(none.pinnedChats)).toEqual([]);
    expect(ids(none.chats)).toEqual(['loose']);
  });

  it("filters a project's pinned chats by search too, and drops a group whose only match is pinned in it", () => {
    const chats = [chat('kept', { projectId: 'a', projectPinned: true }), chat('plain', { projectId: 'a' }), chat('other', { projectId: 'b' })];
    const model = buildSidebar(chats, [project('a', 'Alpha'), project('b', 'Beta')], new Set(['kept']));
    expect(model.groups.map((g) => g.key)).toEqual(['a']);
    expect(ids(model.groups[0]!.pinnedChats)).toEqual(['kept']);
    expect(ids(model.groups[0]!.chats)).toEqual([]);
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

  it('sorts groups and Pinned by sortOrder, highest first, whatever the activity', () => {
    const model = buildSidebar(
      [
        chat('low', { sortOrder: 1, updatedAt: 9 }),
        chat('high', { sortOrder: 9, updatedAt: 1 }),
        chat('mid', { sortOrder: 5 }),
        chat('p1', { pinned: true, sortOrder: 1 }),
        chat('p2', { pinned: true, sortOrder: 2 }),
      ],
      [],
      null
    );
    expect(ids(model.groups[0]!.chats)).toEqual(['high', 'mid', 'low']);
    expect(ids(model.pinned)).toEqual(['p2', 'p1']);
  });

  it('breaks sortOrder ties by newest activity', () => {
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

describe('placeChatPatches', () => {
  const section = [chat('a', { sortOrder: 30 }), chat('b', { sortOrder: 20 }), chat('c', { sortOrder: 10 })];

  it('puts a chat between two others with one patch, half way', () => {
    expect(placeChatPatches(section, section[2]!, 'b')).toEqual([{ id: 'c', sortOrder: 25 }]);
  });

  it('puts a chat at the top, one above the first, and at the bottom, one below the last', () => {
    expect(placeChatPatches(section, section[2]!, 'a')).toEqual([{ id: 'c', sortOrder: 31 }]);
    expect(placeChatPatches(section, section[0]!, null)).toEqual([{ id: 'a', sortOrder: 9 }]);
  });

  it('places a chat coming from another section', () => {
    expect(placeChatPatches(section, chat('x', { sortOrder: 99 }), 'c')).toEqual([{ id: 'x', sortOrder: 15 }]);
    expect(placeChatPatches([], chat('x', { sortOrder: 99 }), null)).toEqual([{ id: 'x', sortOrder: 99 }]);
  });

  it('returns nothing when the chat is already there, or the target is unknown', () => {
    expect(placeChatPatches(section, section[1]!, 'c')).toEqual([]);
    expect(placeChatPatches(section, section[2]!, null)).toEqual([]);
    expect(placeChatPatches(section, section[0]!, 'nope')).toEqual([]);
  });

  it('renumbers the section when the neighbours are too close to fit a value between', () => {
    const tight = [chat('a', { sortOrder: 1 }), chat('b', { sortOrder: 1 }), chat('c', { sortOrder: 0 })];
    expect(placeChatPatches(tight, tight[2]!, 'b')).toEqual([
      { id: 'a', sortOrder: 3 },
      { id: 'c', sortOrder: 2 },
    ]);
  });
});

describe('moveTarget', () => {
  const section = [chat('a'), chat('b'), chat('c')];

  it('moves up above the previous chat, and down above the one after next', () => {
    expect(moveTarget(section, 'b', -1)).toEqual({ beforeId: 'a' });
    expect(moveTarget(section, 'a', 1)).toEqual({ beforeId: 'c' });
    expect(moveTarget(section, 'b', 1)).toEqual({ beforeId: null });
  });

  it('is undefined at either end or for an unknown chat', () => {
    expect(moveTarget(section, 'a', -1)).toBeUndefined();
    expect(moveTarget(section, 'c', 1)).toBeUndefined();
    expect(moveTarget(section, 'z', 1)).toBeUndefined();
  });
});
